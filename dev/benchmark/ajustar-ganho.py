import json, numpy as np, itertools
import sys
tr=json.load(open(sys.argv[1])); te=json.load(open(sys.argv[2]))
def target(g): return 0.0 if g<=1 else min(1.0, np.log(g)/np.log(80))
TIERS=[0.22,0.42,0.62,0.8]
tier=lambda v: np.digitize(v,TIERS)
def feats(r, names):
    cols=[np.ones(len(r))]
    for n in names:
        v=np.array([x[n] if x[n] is not None else np.nan for x in r],float)
        cols.append(v)
    X=np.c_[tuple(cols)]
    return X
y_tr=np.array([target(x['g']) for x in tr]); y_te=np.array([target(x['g']) for x in te])
# imputa sustain ausente com a mediana
for r in (tr,te):
    med=np.nanmedian([x['sustain'] for x in tr if x['sustain'] is not None])
    for x in r:
        if x['sustain'] is None: x['sustain']=med
cands=['flat','crest','spread','hiCrest','sustain','rvAmt']
best=None
for k in range(1,5):
    for names in itertools.combinations(cands,k):
        X=feats(tr,names); w,*_=np.linalg.lstsq(X,y_tr,rcond=None)
        p=np.clip(feats(te,names)@w,0,1); mae=np.mean(np.abs(p-y_te)); acc=np.mean(tier(p)==tier(y_te))
        if best is None or mae<best[0]: best=(mae,acc,names,w)
        if k<=2 or mae<0.12: print('%-40s MAE %.3f tier %.0f%%'%(','.join(names),mae,100*acc))
print('BEST',best[2],'MAE %.3f tier %.0f%%'%(best[0],100*best[1]),'w',np.round(best[3],4).tolist())
# por estilo
names,w=best[2],best[3]
for st in ['strum','muted','lead']:
    m=[x for x in te if x['st']==st]; yy=np.array([target(x['g']) for x in m]); p=np.clip(feats(m,names)@w,0,1)
    print('  ',st,'MAE %.3f faixa certa %.0f%%'%(np.mean(np.abs(p-yy)),100*np.mean(tier(p)==tier(yy))))
