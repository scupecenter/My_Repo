#!/usr/bin/env python3
"""Validate pmis/db/seed/staff-registry*.csv: python3 check_registry.py [file.csv]"""
import csv, re, sys, os
P = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '../../db/seed/staff-registry.draft.csv')
REG = {"Tripoli", "Middle", "WM", "Zawia", "Benghazi", "GM", "Sebha", "All"}
ROLES = {"Project Manager", "RF & Design / Acquisition Team Lead", "CW Team Lead", "TE Team Lead", "Inventory Supervisor", "Project Support"}
rows = list(csv.DictReader(open(P, encoding='utf-8')))
err = []
for k in ('employee_id', 'email', 'phone'):
    seen = set()
    for x in rows:
        if x[k] in seen: err.append('duplicate %s %s' % (k, x[k]))
        seen.add(x[k])
for x in rows:
    i = x['employee_id']
    if not re.fullmatch(r'\d{4}', i): err.append(i + ': id must be 4 digits')
    if not x['name_en'] or not x['name_ar']: err.append(i + ': names required')
    if not re.fullmatch(r'[\w.+-]+@example\.com', x['email']): err.append(i + ': email must be @example.com')
    if not re.fullmatch(r'\+218 9\d \d{3} \d{4}', x['phone']): err.append(i + ': phone format')
    if x['team'] not in ('CW', 'TE', 'both', 'none'): err.append(i + ': team')
    if x['region'] not in REG: err.append(i + ': region')
    if x['status'] not in ('active', 'inactive'): err.append(i + ': status')
    if x['main_role'] not in ROLES: err.append(i + ': main_role')
print('\n'.join(err) or '%d rows OK' % len(rows))
sys.exit(1 if err else 0)
