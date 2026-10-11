import json,os
here=os.path.dirname(os.path.abspath(__file__))
root=os.path.dirname(here)
s=open(os.path.join(here,'castle.src.html'),encoding='utf-8').read()
c=json.load(open(os.path.join(here,'clips.json')))
out=s.replace('__CLIPS__',json.dumps(c,separators=(',',':')))
open(os.path.join(root,'index.html'),'w',encoding='utf-8').write(out)
print('index.html',len(out.encode()),'bytes')
