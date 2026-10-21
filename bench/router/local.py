"""The cheapest local router that could work: TF-IDF + one logistic regression per tier predicting P(pass).
It routes to the tier with the lowest expected loss, mean cost + (1 - P(pass)) * FAIL (same FAIL as score.mjs).
  python -I bench/router/local.py CASES.jsonl OUT.jsonl [FAIL]
Trains on the train split, answers the test split. A stand-in for laya / a distilled judge, to show what a local model can learn.
"""
import sys, json, numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression

T = ['S', 'M', 'L']
cases = [json.loads(l) for l in open(sys.argv[1], encoding='utf-8')]
fail = float(sys.argv[3]) if len(sys.argv) > 3 else 0.01
tr = [c for c in cases if c['split'] == 'train']; te = [c for c in cases if c['split'] == 'test']
vec = TfidfVectorizer(ngram_range=(1, 2), min_df=3, max_features=100_000, sublinear_tf=True)
X = vec.fit_transform([c['prompt'][:4000] for c in tr]); Xt = vec.transform([c['prompt'][:4000] for c in te])
cost = np.array([np.mean([c['cost'][t] for c in tr]) for t in T])
p = np.column_stack([
    LogisticRegression(C=4, max_iter=300).fit(X, [c['pass'][t] >= 0.5 for c in tr]).predict_proba(Xt)[:, 1] for t in T
])
pick = np.argmin(cost + (1 - p) * fail, axis=1)
with open(sys.argv[2], 'w') as f:
    for c, i in zip(te, pick): f.write(json.dumps({'id': c['id'], 'tier': T[i]}) + '\n')
print(len(tr), 'train', len(te), 'test')
