// Lazy exact subthreshold evolution (DOOMFLY model, unchanged dynamics).
// An inactive neuron is skipped only when its voltage AND both its instantaneous
// and asymptotic drive are below threshold: with no incoming event it cannot fire.
// Every edge is retained.
//
// Parallel version. Neuron i is owned by thread (i/BLOCK)%threads for the whole
// call: each thread integrates its own active list and receives its own
// postsynaptic input, so no cell is ever touched by two threads at once and the
// arithmetic order per cell is fixed. Results are deterministic for a given
// thread count and match the serial kernel to float rounding.
#include <cmath>
#include <cstdint>
#include <vector>
#ifdef _OPENMP
#include <omp.h>
#endif

extern "C" int neural_set_threads(int requested){
#ifdef _OPENMP
 if(requested>0)omp_set_num_threads(requested);
 return omp_get_max_threads();
#else
 return 1;
#endif
}

extern "C" void neural_advance(
 int n,const int64_t* ptr,const int32_t* post,const float* weight,
 float* v,float* g,int16_t* refractory,const float* drive,float* previous_drive,
 int32_t* queue,int32_t* queue_count,int64_t* clock,int steps,float dt,int32_t* counts,
 int32_t* active,uint8_t* flags,int32_t* nactive,int64_t* last) {
 const int delay=std::lround(1.8f/dt),rfc=std::lround(2.2f/dt),slots=delay+1;
 float av[1024],ag[1024];
 for(int i=0;i<1024;i++){av[i]=std::exp(-dt*i/20.f);ag[i]=std::exp(-dt*i/5.f);}
 auto evolve=[&](int i,int64_t now,float current){
   int64_t d=now-last[i];if(d<=0)return;
   const int frozen=refractory[i]>0?refractory[i]-1:0;
   const int skip=(int)(d<frozen?d:frozen);
   refractory[i]=d>=refractory[i]?0:refractory[i]-d;d-=skip;
   if(d>0){const float a=d<1024?av[d]:std::exp(-dt*d/20.f),b=d<1024?ag[d]:std::exp(-dt*d/5.f);
     v[i]=-52.f+(v[i]+52.f)*a+current*(1.f-a)+g[i]*(a-b)/3.f;g[i]*=b;}
   last[i]=now;
 };
 int threads=1;
#ifdef _OPENMP
 threads=omp_get_max_threads();
#endif
 const int BLOCK=256;
 auto owner=[&](int i){return threads>1?(i/BLOCK)%threads:0;};
 std::vector<std::vector<int32_t>> mine(threads),fired(threads);
 // Apply changing sensory currents only after settling old-current history.
 for(int i=0;i<n;i++)if(drive[i]!=previous_drive[i]){
   evolve(i,*clock-1,previous_drive[i]);previous_drive[i]=drive[i];
   if(!flags[i]){flags[i]=1;active[(*nactive)++]=i;}
 }
 std::vector<int> offsets(threads+1,0);
#pragma omp parallel num_threads(threads)
 {
   int tid=0;
#ifdef _OPENMP
   tid=omp_get_thread_num();
#endif
   std::vector<int32_t>& my=mine[tid];
   std::vector<int32_t>& my_fired=fired[tid];
   // Take ownership of the incoming active list.
   {
     const int na=*nactive;
     for(int k=0;k<na;k++){const int i=active[k];if(owner(i)==tid)my.push_back(i);}
   }
   const int64_t clock0=*clock;
   for(int t=0;t<steps;t++){
     const int64_t now=clock0+t;
     const int slot=now%slots,future=(now+delay)%slots;
     my_fired.clear();
     // Integrate + threshold my active cells, compacting the list in place.
     size_t kept=0;
     for(size_t k=0;k<my.size();k++){
       const int i=my[k];evolve(i,now,drive[i]);
       if(refractory[i]==0 && v[i]>-45.f){my_fired.push_back(i);counts[i]++;}
       // Convex relaxation toward drive+g(t): the bound makes this exact in
       // real arithmetic, not an activity cutoff or a dropped weak connection.
       const bool can_fire=v[i]>-45.f || drive[i]>7.f || drive[i]+g[i]>7.f;
       if(can_fire)my[kept++]=i;else flags[i]=0;
     }
     my.resize(kept);
     // Reset the cells that just fired. In the reference this happens after the
     // delivery below; the order is equivalent because a cell that fired this step
     // has last[i]==now (evolve is a no-op) and is refractory (no input is added).
     for(int32_t i:my_fired){v[i]=-52.f;g[i]=0.f;refractory[i]=rfc;}
#pragma omp barrier
#pragma omp single
     {
       // The future slot is the slot delivered in the previous step; it is free now.
       int32_t* qf=queue+(int64_t)future*n;int qc=0;
       for(int th=0;th<threads;th++)for(int32_t i:fired[th])qf[qc++]=i;
       queue_count[future]=qc;
     }
     // (implicit barrier) Deliver spikes that fired `delay` steps ago: every thread
     // scans the same spike list and touches only the cells it owns. No barrier is
     // needed before the next integration pass: both touch only owned cells.
     {
       const int32_t* qs=queue+(int64_t)slot*n;const int qn=queue_count[slot];
       for(int q=0;q<qn;q++){
         const int i=qs[q];
         for(int64_t e=ptr[i];e<ptr[i+1];e++){
           const int j=post[e];
           if(owner(j)!=tid)continue;
           evolve(j,now,drive[j]);
           if(refractory[j]==0){g[j]+=weight[e];if(!flags[j]){flags[j]=1;my.push_back(j);}}
         }
       }
     }
   }
#pragma omp barrier
#pragma omp single
   {
     *clock=clock0+steps;
     // Slots delivered in the last step keep their counts in the reference until the
     // next step clears them; clear the just-delivered slot here to match.
     queue_count[(clock0+steps-1)%slots]=0;
   }
   // Hand the active list back in thread order.
#pragma omp single
   {
     for(int th=0;th<threads;th++)offsets[th+1]=offsets[th]+(int)mine[th].size();
     *nactive=offsets[threads];
   }
   for(size_t k=0;k<my.size();k++)active[offsets[tid]+k]=my[k];
   // Materialize all states at the observation boundary (no threshold can be
   // missed in sleeping cells). This also supports auditable voltage readouts.
   const int64_t end=*clock-1;
#pragma omp for schedule(static)
   for(int i=0;i<n;i++)evolve(i,end,drive[i]);
 }
}
