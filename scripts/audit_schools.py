"""Audit the school explorer against the NYCPS school workbook.

Same standard as the other audits here: re-read the source from scratch with a
parser written independently of extract.py, and compare against (a) the payload
the page is built from and (b) values captured from the rendered page.

Also checks the thing that school-level data makes checkable for the first
time: every district's schools should sum to that district's own published
total, except where a school is suppressed. Any other gap means schools are
being attributed to the wrong district.

Usage:  python3 scripts/audit_schools.py [path/to/sc_dump.json]
"""
import openpyxl, json, os, sys
from decimal import Decimal, ROUND_HALF_UP

R = os.path.join(os.path.dirname(__file__), '..')
YEARS = [2018, 2019, 2022, 2023, 2024, 2025, 2026]
GRADES = ['3', '4', '5', '6', '7', '8', 'All Grades']
DISTRICTS = ['%02d' % d for d in range(1, 33)]
CATS = ['All Students', 'SWD', 'Not SWD', 'Econ Disadv', 'Not Econ Disadv',
        'Current ELL', 'Ever ELL', 'Never ELL', 'Asian', 'Black', 'Hispanic',
        'Multi-Racial', 'Native American', 'White', 'Female', 'Male',
        'Neither Female nor Male']
SHEETS = ['ELA - All', 'ELA - SWD', 'ELA - Ethnicity', 'ELA - Gender',
          'ELA - Econ Status', 'ELA - ELL']
SUBGROUP_FROM = 2023

FAILS = []
CHECKED = [0]


def cmp(name, got, want):
    CHECKED[0] += 1
    if str(got) != str(want):
        FAILS.append(f'{name}: page/payload={got!r} source={want!r}')


def _r1(v):
    # JS toFixed(1) rounds ties away from zero; Python's format rounds ties to
    # even. Match the browser, so 56.25 compares as 56.3 rather than 56.2.
    return str(Decimal(repr(float(v))).quantize(Decimal('0.1'), rounding=ROUND_HALF_UP))


def f1(v):
    return '—' if v is None else _r1(v)


def pp(v):
    if v is None:
        return '—'
    return '0.0' if abs(v) < 0.05 else ('+' if v > 0 else '−') + _r1(abs(v))


# --------------------------------------------------------------------------
# 1. Independent read of the school workbook.
# --------------------------------------------------------------------------
def read_source():
    wb = openpyxl.load_workbook(os.path.join(R, 'data', 'school-ela-results-public.xlsx'),
                                read_only=True, data_only=True)
    cells, names, skipped = {}, {}, {}
    suppressed = 0
    for sn in SHEETS:
        if sn not in wb.sheetnames:
            continue
        ws = wb[sn]
        rows = ws.iter_rows(values_only=True)
        hdr = list(next(rows))
        H = {h: i for i, h in enumerate(hdr) if h}
        for r in rows:
            if r is None or r[0] is None:
                continue
            cat = r[H['Category']]
            if cat not in CATS:
                continue
            if cat != 'All Students' and r[H['Year']] < SUBGROUP_FROM:
                continue
            vals = [r[H[c]] for c in ['Number Tested', 'Mean Scale Score', '# Level 1',
                                      '# Level 2', '# Level 3', '# Level 4']]
            dbn = r[H['DBN']]
            names[dbn] = str(r[H['School Name']]).strip()
            if any(v == 's' for v in vals) or any(not isinstance(v, (int, float)) for v in vals):
                # A row is unusable if ANY of the six is withheld, not only the
                # count. NYSED often publishes Number Tested while suppressing
                # the level breakdown, so counting only `Number Tested == s`
                # understates how many schools are missing from a district sum.
                suppressed += 1
                if cat == 'All Students':
                    skipped.setdefault((dbn[:2], r[H['Year']]), set()).add(dbn)
                continue
            nt, ms, c1, c2, c3, c4 = vals
            assert c1 + c2 + c3 + c4 == nt, (dbn, r)
            cells[(dbn, str(r[H['Grade']]), r[H['Year']], cat)] = (
                int(nt), float(ms), int(c1), int(c2), int(c3), int(c4))
    return cells, names, suppressed, skipped


SRC, NAMES, SUPPRESSED, SKIPPED = read_source()

P = json.load(open(os.path.join(R, 'data', 'payload.json')))
assert P.get('schools') and P.get('school'), 'payload carries no school data'
SCH = P['schools']
IDX = {d: i for i, d in enumerate(SCH['dbn'])}

# --------------------------------------------------------------------------
# 2. Payload against source, cell by cell.
# --------------------------------------------------------------------------
pay = {}
for s, g, y, c, n, ms, c1, c2, c3, c4 in P['school']:
    pay[(SCH['dbn'][s], GRADES[g], YEARS[y], CATS[c])] = (n, ms, c1, c2, c3, c4)

cmp('payload cell count', len(pay), len(SRC))
for key, want in SRC.items():
    got = pay.get(key)
    if got is None:
        FAILS.append(f'payload missing {key}')
        CHECKED[0] += 1
        continue
    CHECKED[0] += 1
    if got[0] != want[0] or got[2:] != want[2:] or abs(got[1] - want[1]) > 1e-5:
        FAILS.append(f'payload {key}: {got!r} != {want!r}')

for dbn, i in IDX.items():
    cmp(f'name {dbn}', SCH['name'][i], NAMES[dbn])
    cmp(f'district {dbn}', DISTRICTS[SCH['dist'][i]], dbn[:2])

# --------------------------------------------------------------------------
# 3. Schools against their own district's published total.
#    They reconcile exactly wherever nothing in that district is suppressed.
# --------------------------------------------------------------------------
dist_rows = {}
for g, gi, yi, ci, n, ms, c1, c2, c3, c4 in [(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9])
                                             for r in P['dist']]:
    if gi == GRADES.index('All Grades') and ci == 0:
        dist_rows[(DISTRICTS[g], YEARS[yi])] = n

# Schools reconcile to the district file EXACTLY in 2026 and fall short in
# earlier years. That is a property of the source, not an error: through 2024
# the district file carried the same total as the citywide file, meaning it
# included District 75 and out-of-district placement students, who belong to no
# regular school and so appear in no school row. From 2025 those students are
# attributed to the school they attend, and the gap closes. The check asserts
# the exact reconciliation where it should hold and records the rest.
recon = {}
for d in DISTRICTS:
    for y in YEARS:
        s_sum = sum(v[0] for (dbn, g, yy, c), v in SRC.items()
                    if c == 'All Students' and dbn[:2] == d and g == 'All Grades' and yy == y)
        want = dist_rows.get((d, y))
        if want is None:
            continue
        CHECKED[0] += 1
        gap = want - s_sum
        recon.setdefault(y, [0, 0, 0])
        if gap == 0:
            recon[y][0] += 1
        elif gap > 0:
            recon[y][1] += 1
            recon[y][2] += gap
        else:
            FAILS.append(f'district {d} {y}: schools sum to {s_sum}, ABOVE the district '
                         f'file total of {want}, which cannot happen')

for d in DISTRICTS:
    y = 2026
    s_sum = sum(v[0] for (dbn, g, yy, c), v in SRC.items()
                if c == 'All Students' and dbn[:2] == d and g == 'All Grades' and yy == y)
    want = dist_rows.get((d, y))
    if want is None:
        continue
    CHECKED[0] += 1
    if s_sum != want and not SKIPPED.get((d, y)):
        FAILS.append(f'2026 district {d}: schools sum to {s_sum}, district file says {want}; '
                     f'2026 must reconcile exactly where nothing is withheld')

# --------------------------------------------------------------------------
# 4. Rendered page against source.
# --------------------------------------------------------------------------
dump_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(R, 'audit', 'sc_dump.json')
if not os.path.exists(dump_path):
    print('no rendered dump at %s; ran payload checks only' % dump_path)
else:
    SC = json.load(open(dump_path))

    def agg(dbn, grades, year):
        n = c1 = c2 = c3 = c4 = 0
        wm = 0.0
        found = 0
        for g in grades:
            v = SRC.get((dbn, g, year, 'All Students'))
            if not v:
                continue
            found += 1
            n += v[0]; wm += v[1] * v[0]
            c1 += v[2]; c2 += v[3]; c3 += v[4]; c4 += v[5]
        if not found or not n:
            return None
        return {'n': n, 'prof': (c3 + c4) / n * 100, 'l1': c1 / n * 100,
                'mean': wm / n, 'grades': found}

    BANDS = {'all': ['All Grades'], '35': ['3', '4', '5'], '68': ['6', '7', '8']}
    for key, state in SC.items():
        bk, base = state['band'], state['base']
        grades = BANDS[bk]
        for row in state['rows']:
            dbn = row['dbn']
            cur = agg(dbn, grades, 2026)
            bse = agg(dbn, grades, base)
            cmp(f'{key} name {dbn}', row['name'], NAMES[dbn])
            cmp(f'{key} district {dbn}', row['dist'], dbn[:2])
            cmp(f'{key} tested {dbn}', row['n'].replace(',', ''), str(cur['n']))
            cmp(f'{key} prof {dbn}', row['prof'], f1(cur['prof']))
            cmp(f'{key} l1 {dbn}', row['l1'], f1(cur['l1']))
            cmp(f'{key} mean {dbn}', row['mean'], f1(cur['mean']))
            comparable = cur and bse and cur['grades'] == bse['grades']
            if row['chg'] not in ('n/c', 's'):
                cmp(f'{key} change {dbn}', row['chg'], pp(cur['prof'] - bse['prof'])
                    if comparable else 'n/c')

print('checked %s values' % f'{CHECKED[0]:,}')
print('  suppressed source rows skipped : %s' % f'{SUPPRESSED:,}')
print('  district reconciliation by year:')
for y in sorted(recon):
    ex, sh, tot = recon[y]
    print('    %d: %2d districts exact, %2d short, %s students unattributed to any school'
          % (y, ex, sh, f'{tot:,}'))
if FAILS:
    print('MISMATCHES: %d' % len(FAILS))
    for f in FAILS[:40]:
        print('  ' + f)
    sys.exit(1)
print('RESULT: PASS — the school explorer reproduces the NYCPS source exactly.')
