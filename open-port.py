import json, subprocess, os, re
def o(*a): return json.loads(subprocess.check_output(['oci', *a]))['data']
def camel(x):
    if isinstance(x, dict): return {re.sub(r'-(\w)', lambda m: m.group(1).upper(), k): camel(v) for k, v in x.items()}
    if isinstance(x, list): return [camel(i) for i in x]
    return x
t = os.environ['OCI_TENANCY']
I = o('compute', 'instance', 'list', '--compartment-id', t, '--lifecycle-state', 'RUNNING')[0]['id']
v = o('compute', 'instance', 'list-vnics', '--instance-id', I, '--compartment-id', t)[0]
s = o('network', 'subnet', 'get', '--subnet-id', v['subnet-id'])
for sid in s['security-list-ids']:
    sl = o('network', 'security-list', 'get', '--security-list-id', sid)
    rules = camel(sl['ingress-security-rules'])
    if any(((r.get('tcpOptions') or {}).get('destinationPortRange') or {}).get('min') == 3000 for r in rules):
        print('already open'); continue
    rules.append({'protocol': '6', 'source': '0.0.0.0/0', 'isStateless': False, 'tcpOptions': {'destinationPortRange': {'min': 3000, 'max': 3000}}})
    json.dump(rules, open('/tmp/r.json', 'w'))
    subprocess.check_call(['oci', 'network', 'security-list', 'update', '--security-list-id', sid, '--ingress-security-rules', 'file:///tmp/r.json', '--force'], stdout=subprocess.DEVNULL)
    print('opened 3000')
