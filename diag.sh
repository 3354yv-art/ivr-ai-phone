#!/bin/bash
curl -sv -m 8 http://129.159.151.3:3000/health 2>&1 | tail -n 5
python3 - <<'PY'
import json, subprocess, os
o = lambda *a: json.loads(subprocess.check_output(['oci', *a]))['data']
t = os.environ['OCI_TENANCY']
I = o('compute', 'instance', 'list', '--compartment-id', t, '--lifecycle-state', 'RUNNING')[0]['id']
v = o('compute', 'instance', 'list-vnics', '--instance-id', I, '--compartment-id', t)[0]
print('NSG', v.get('nsg-ids'))
s = o('network', 'subnet', 'get', '--subnet-id', v['subnet-id'])
for i in s['security-list-ids']:
    for r in o('network', 'security-list', 'get', '--security-list-id', i)['ingress-security-rules']:
        print(r['protocol'], r['source'], (r.get('tcp-options') or {}).get('destination-port-range'))
PY
