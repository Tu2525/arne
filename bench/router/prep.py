"""Turn the public datasets into cases the harness scores. Run with an isolated interpreter:
  python -I bench/router/prep.py ROUTERBENCH.pkl SWEBENCH.parquet OUTDIR
cases-routerbench.jsonl: {id, split, prompt, task, pass:{S,M,L}, cost:{S,M,L}}  (old models stand in for tiers)
cases-swebench.jsonl:    {id, split, prompt, label, difficulty}                 (human fix-time estimate -> tier)
"""
import sys, ast, json, pickle, zlib, warnings, pandas as pd
warnings.filterwarnings('ignore')

# A pickle can run code, so only numpy/pandas classes may load.
class Safe(pickle.Unpickler):
    def find_class(self, mod, name):
        if mod.split('.')[0] in ('numpy', 'pandas', 'builtins', 'collections', 'datetime') and name not in ('eval', 'exec', 'open', '__import__', 'compile'):
            return super().find_class(mod, name)
        raise pickle.UnpicklingError(f'blocked {mod}.{name}')

# RouterBench has no Claude 5 models. Three of its models stand in for the ladder, cheap to dear.
TIERS = {'S': 'claude-instant-v1', 'M': 'claude-v2', 'L': 'gpt-4-1106-preview'}
DIFF = {'<15 min fix': 'S', '15 min - 1 hour': 'M', '1-4 hours': 'L', '>4 hours': 'L'}

def split(id_): return 'test' if zlib.crc32(str(id_).encode()) % 5 == 0 else 'train'

def first(p):
    # RouterBench stores a prompt as the text of a Python list of turns
    if isinstance(p, str) and p[:2] in ("['", '["'):
        try: p = ast.literal_eval(p)
        except (ValueError, SyntaxError): pass
    return p if isinstance(p, str) else '\n'.join(map(str, p))

def main(rb_path, sw_path, out):
    rb = Safe(open(rb_path, 'rb')).load()
    q = rb[list(TIERS.values())].astype(float)
    c = rb[[m + '|total_cost' for m in TIERS.values()]].astype(float)
    with open(f'{out}/cases-routerbench.jsonl', 'w', encoding='utf-8') as f:
        for i in range(len(rb)):
            sid = rb.sample_id.iloc[i]
            f.write(json.dumps({'id': f'rb-{sid}', 'split': split(sid), 'prompt': first(rb.prompt.iloc[i]), 'task': rb.eval_name.iloc[i],
                'pass': dict(zip(TIERS, q.iloc[i])), 'cost': dict(zip(TIERS, c.iloc[i]))}) + '\n')
    sw = pd.read_parquet(sw_path)
    with open(f'{out}/cases-swebench.jsonl', 'w', encoding='utf-8') as f:
        for r in sw.itertuples(index=False):
            f.write(json.dumps({'id': f'sw-{r.instance_id}', 'split': 'test', 'prompt': r.problem_statement[:4000],
                'label': DIFF[r.difficulty], 'difficulty': r.difficulty}) + '\n')
    print(len(rb), 'routerbench cases;', len(sw), 'swebench cases')

main(*sys.argv[1:4])
