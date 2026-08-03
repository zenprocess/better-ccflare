#!/usr/bin/env python3
"""Convert Bun junit XML to cal-kiwi push JSON: [{status, ...}, ...]"""
import sys
import json
import xml.etree.ElementTree as ET

path = sys.argv[1]
tree = ET.parse(path)
root = tree.getroot()

results = []
for ts in root.iter('testcase'):
    name = ts.get('name')
    file = ts.get('file')
    line = ts.get('line')
    time = ts.get('time')
    if ts.find('failure') is not None or ts.find('error') is not None:
        status = 'fail'
    elif ts.find('skipped') is not None:
        status = 'skip'
    else:
        status = 'pass'
    results.append({
        'name': name,
        'status': status,
        'file': file,
        'line': int(line) if line else None,
        'time': float(time) if time else 0,
    })

out = {
    'results': results,
    'summary': {
        'total': len(results),
        'pass': sum(1 for r in results if r['status'] == 'pass'),
        'fail': sum(1 for r in results if r['status'] == 'fail'),
        'skip': sum(1 for r in results if r['status'] == 'skip'),
    },
}
print(json.dumps(out))