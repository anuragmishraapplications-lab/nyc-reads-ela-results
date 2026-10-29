"""Extract NYC ELA results into a compact JSON payload for the dashboard.

Design notes (audited):
  * The raw files are internally exact: #L1+#L2+#L3+#L4 == Number Tested,
    %Lx == #Lx / Number Tested * 100 (to float precision), #L3+4 == #L3+#L4.
    Therefore we store COUNTS ONLY and derive every percentage in the browser.
    This guarantees that aggregation (across districts / across grades) is exact
    and that no displayed percentage is a rounded-input-of-a-rounded-input.
  * Suppressed cells ('s') are dropped; the UI renders them as 's'.
"""
import openpyxl, json, os, sys

YEARS  = [2018, 2019, 2022, 2023, 2024, 2025, 2026]
GRADES = ['3', '4', '5', '6', '7', '8', 'All Grades']
YI = {y: i for i, y in enumerate(YEARS)}
GI = {g: i for i, g in enumerate(GRADES)}

SHEETS = ['ELA - All', 'ELA - SWD', 'ELA - Ethnicity', 'ELA - Gender',
          'ELA - Econ Status', 'ELA - ELL', 'ELA - Gender by Ethnicity']

# canonical category ordering -> index
CATS = ['All Students',
        'SWD', 'Not SWD',
        'Econ Disadv', 'Not Econ Disadv',
        'Current ELL', 'Ever ELL', 'Never ELL',
        'Asian', 'Black', 'Hispanic', 'Multi-Racial', 'Native American', 'White',
        'Female', 'Male', 'Neither Female nor Male']
CI = {c: i for i, c in enumerate(CATS)}

# Display names for the reported groups.
# The Category column in the source files uses abbreviations ('SWD',
# 'Econ Disadv'). NYCPS asked that the dashboard spell these out. The keys
# below are the file's exact strings and are what every lookup uses; the
# values are what the reader sees. Nothing about the data changes.
CAT_LABEL = {
    'All Students':            'All Students',
    'SWD':                     'Students with Disabilities',
    'Not SWD':                 'Students without Disabilities',
    'Econ Disadv':             'Economically Disadvantaged Students',
    'Not Econ Disadv':         'Students Not Economically Disadvantaged',
    'Current ELL':             'Current English Language Learners',
    # 'Ever ELL' is the file's term for students who WERE identified as ELLs
    # and no longer are. It is not a superset of 'Current ELL': the three ELL
    # categories are mutually exclusive and sum to All Students exactly, in
    # every year (asserted below). NYCPS's own 2026 Results Summary defines it
    # as "students identified as ELLs any year prior to the testing year but
    # not including the testing year", so "Ever" here means former, and a
    # label reading "Ever English Language Learners" invites the reader to
    # take it as current-plus-former.
    'Ever ELL':                'Former English Language Learners',
    'Never ELL':               'Never English Language Learners',
    'Asian':                   'Asian',
    'Black':                   'Black',
    'Hispanic':                'Hispanic',
    'Multi-Racial':            'Multi-Racial',
    'Native American':         'Native American',
    'White':                   'White',
    'Female':                  'Female',
    'Male':                    'Male',
    'Neither Female nor Male': 'Neither Female nor Male',
}

# The source tab each category is read from. Carried into the payload so the
# glossary on the Subgroups page can state, for every on-screen label, the
# exact Category string and the tab it came from, and be checked against the
# workbook without opening this script.
CAT_SHEET = {
    'All Students':            'ELA - All',
    'SWD':                     'ELA - SWD',
    'Not SWD':                 'ELA - SWD',
    'Econ Disadv':             'ELA - Econ Status',
    'Not Econ Disadv':         'ELA - Econ Status',
    'Current ELL':             'ELA - ELL',
    'Ever ELL':                'ELA - ELL',
    'Never ELL':               'ELA - ELL',
    'Asian':                   'ELA - Ethnicity',
    'Black':                   'ELA - Ethnicity',
    'Hispanic':                'ELA - Ethnicity',
    'Multi-Racial':            'ELA - Ethnicity',
    'Native American':         'ELA - Ethnicity',
    'White':                   'ELA - Ethnicity',
    'Female':                  'ELA - Gender',
    'Male':                    'ELA - Gender',
    'Neither Female nor Male': 'ELA - Gender',
}

# Definitions taken verbatim from the source, for the glossary. Only groups
# whose meaning is not obvious from the label, or where the label and the
# file's Category string differ enough to need saying, carry one.
CAT_NOTE = {
    'Ever ELL': 'Students identified as English Language Learners in a year before the testing '
                'year and not in the testing year. The three English Language Learner categories '
                'are mutually exclusive and sum to all tested students.',
    'Current ELL': 'Students identified as English Language Learners during the testing year.',
    'Never ELL': 'Students never identified as English Language Learners.',
    'Asian': 'Includes Native Hawaiian or Other Pacific Islanders (NYCPS notes).',
    'Econ Disadv': 'Students identified by the State as eligible for free or reduced-price lunch '
                   'or other economic assistance programs (NYCPS notes).',
    'Neither Female nor Male': 'Reported on the Gender tab from 2023 onward (NYCPS notes).',
}

# which sheet a category belongs to (dimension grouping for the UI)
DIMS = [
    ('all',   'All Students',              ['All Students']),
    ('swd',   'Students with Disabilities', ['SWD', 'Not SWD']),
    ('econ',  'Economic Status',            ['Econ Disadv', 'Not Econ Disadv']),
    ('ell',   'English Language Learners',  ['Current ELL', 'Ever ELL', 'Never ELL']),
    ('eth',   'Ethnicity',                  ['Asian', 'Black', 'Hispanic', 'Multi-Racial',
                                             'Native American', 'White']),
    ('gen',   'Gender',                     ['Female', 'Male', 'Neither Female nor Male']),
]

BORO_OF = {}
for d in range(1, 7):   BORO_OF['%02d' % d] = 'Manhattan'
for d in range(7, 13):  BORO_OF['%02d' % d] = 'Bronx'
for d in list(range(13, 24)) + [32]: BORO_OF['%02d' % d] = 'Brooklyn'
for d in range(24, 31): BORO_OF['%02d' % d] = 'Queens'
BORO_OF['31'] = 'Staten Island'

BOROS = ['Bronx', 'Brooklyn', 'Manhattan', 'Queens', 'Staten Island']
BORO_KEY = {'BRONX': 'Bronx', 'BROOKLYN': 'Brooklyn', 'MANHATTAN': 'Manhattan',
            'QUEENS': 'Queens', 'STATEN ISLAND': 'Staten Island'}
DISTRICTS = ['%02d' % d for d in range(1, 33)]

# NYC Reads launch timeline (source: NYCPS "NYC Reads phase info", verified
# against the screenshot supplied by the team on 2026-08-11).
PHASE = {
    'elem1': [5, 11, 12, 14, 16, 19, 20, 21, 22, 23, 25, 26, 29, 30, 32],   # +75 (not in files)
    'elem2': [1, 2, 3, 4, 6, 7, 8, 9, 10, 13, 15, 17, 18, 24, 27, 28, 31],  # +75
    'ms1':   [1, 3, 7, 9, 11, 12, 13, 19],
    'ms2':   [2, 4, 8, 10, 14, 18, 20, 26, 29, 32],                          # +75
}

# ---------------------------------------------------------------------------
# NYC Reads / NYC Solves vendor and curriculum assignments, by district.
# Source: "2026-27 District Reads Solves Data (Draft).xlsx", sheet
# "District Sustainability Conditi".
#
# ONLY the vendor, curriculum and year-joined columns are read. The source
# sheet also carries superintendent and deputy names, their email addresses,
# and internal district-condition narrative. None of that is loaded, and the
# source workbook is kept out of version control (see .gitignore), because the
# published dashboard is public.
# ---------------------------------------------------------------------------
VENDOR_SRC = 'private/2026-27 District Reads Solves Data (Draft).xlsx'
VENDOR_SHEET = 'District Sustainability Conditi'
VENDOR_COLS = ('Reads Vendor', 'Solves Vendor', 'NYC Reads Elementary Curriculum',
               'NYC Reads MS Curriculum', 'NYC Solves Curriculum')
BANNED_COLS = ('Superintendent', 'Supt Email', 'Dept Supt', 'Dep Supt Email', 'Supt')

stats = {'read': 0, 'kept': 0, 'suppressed': 0, 'bad': 0}
CHECKS = []          # populated by read_level / main; every one must pass
INVENTORY = []


DEV = {'pct': 0.0, 'p34': 0.0, 'sum100': 0.0}


def read_level(path, idcol):
    """Return list of (idvalue, gradeIdx, yearIdx, catIdx, nTested, mean, c1,c2,c3,c4)."""
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    out = []
    local = {'loaded': 0, 'suppressed': 0}
    for sn in wb.sheetnames:
        if sn not in SHEETS:
            continue
        ws = wb[sn]
        rows = ws.iter_rows(values_only=True)
        hdr = list(next(rows))
        H = {h: i for i, h in enumerate(hdr)}
        need = ['Grade', 'Year', 'Category', 'Number Tested', 'Mean Scale Score',
                '# Level 1', '# Level 2', '# Level 3', '# Level 4', '# Level 3+4',
                '% Level 1', '% Level 2', '% Level 3', '% Level 4', '% Level 3+4']
        missing = [c for c in need if c not in H]
        assert not missing, (path, sn, missing)
        for r in rows:
            if r is None or r[0] is None:
                continue
            stats['read'] += 1
            cat = r[H['Category']]
            if cat not in CI:                       # e.g. Gender-by-Ethnicity combos
                continue
            vals = [r[H[c]] for c in ['Number Tested', 'Mean Scale Score', '# Level 1',
                                      '# Level 2', '# Level 3', '# Level 4']]
            if any(v == 's' for v in vals):
                stats['suppressed'] += 1
                local['suppressed'] += 1
                continue
            if any(not isinstance(v, (int, float)) for v in vals):
                stats['bad'] += 1
                continue
            nt, ms, c1, c2, c3, c4 = vals
            # hard invariants -- refuse to emit a row that violates them
            assert c1 + c2 + c3 + c4 == nt, (path, sn, r)
            assert r[H['# Level 3+4']] == c3 + c4, (path, sn, r)
            if nt:
                for c, pk in zip((c1, c2, c3, c4),
                                 ('% Level 1', '% Level 2', '% Level 3', '% Level 4')):
                    d = abs(c / nt * 100 - r[H[pk]])
                    DEV['pct'] = max(DEV['pct'], d)
                    assert d < 1e-4, (path, sn, pk, r)
                d = abs((c3 + c4) / nt * 100 - r[H['% Level 3+4']])
                DEV['p34'] = max(DEV['p34'], d)
                assert d < 1e-4, (path, sn, r)
                d = abs(sum(r[H[k]] for k in ('% Level 1', '% Level 2',
                                              '% Level 3', '% Level 4')) - 100)
                DEV['sum100'] = max(DEV['sum100'], d)
                assert d < 1e-3, (path, sn, r)
            gi = GI[str(r[H['Grade']])]
            yi = YI[r[H['Year']]]
            idv = r[H[idcol]] if idcol else None
            out.append([idv, gi, yi, CI[cat], int(nt), round(float(ms), 6),
                        int(c1), int(c2), int(c3), int(c4)])
            stats['kept'] += 1
            local['loaded'] += 1
    INVENTORY.append((os.path.basename(path), local['loaded'], local['suppressed']))
    return out


def pack(rows, geo_index):
    """[geoIdx, gradeIdx, yearIdx, catIdx, n, mean, c1,c2,c3,c4]"""
    packed = []
    for idv, gi, yi, ci, nt, ms, c1, c2, c3, c4 in rows:
        g = 0 if geo_index is None else geo_index[idv]
        packed.append([g, gi, yi, ci, nt, ms, c1, c2, c3, c4])
    packed.sort()
    return packed


def read_vendors(base):
    """District -> provider / curriculum for SY 2025-26.

    Source: the curriculum-and-JESP chart supplied by the team on 11 Aug 2026,
    transcribed into data/vendors_sy2025_26.json. That is the school year the
    spring 2026 test measures, so it is the correct vintage for these results;
    the 2026-27 draft workbook describes assignments that begin AFTER the 2026
    test and is no longer used for provider or curriculum.

    JESP is the job-embedded support provider, i.e. the professional learning
    vendor. K-5 and grades 6-8 are held separately because they differ.

    The chart also carries a Phase column. It disagrees with the NYCPS launch
    timeline for seven districts, and the timeline is corroborated by the
    "year joined" columns of the 2026-27 workbook for all 32, so the phase
    assignments are NOT taken from the chart. The disagreement is carried into
    the payload so the dashboard can show it rather than hide it.
    """
    path = os.path.join(base, 'vendors_sy2025_26.json')
    if not os.path.exists(path):
        print('WARNING: vendor source not found, provider page will be empty')
        return None
    with open(path) as f:
        src = json.load(f)
    recs = src['districts']
    assert len(recs) == 32, 'expected 32 districts, got %d' % len(recs)

    def roster(key):
        return sorted({recs[str(d)][key] for d in range(1, 33) if recs[str(d)][key]})
    kj, kc = roster('k5Jesp'), roster('k5Curr')
    mj, mc = roster('msJesp'), roster('msCurr')

    def idx(r, v):
        return r.index(v) if v else None
    by = [{'kj': idx(kj, recs[str(d)]['k5Jesp']), 'kc': idx(kc, recs[str(d)]['k5Curr']),
           'mj': idx(mj, recs[str(d)]['msJesp']), 'mc': idx(mc, recs[str(d)]['msCurr'])}
          for d in range(1, 33)]

    official = {**{d: 1 for d in PHASE['elem1']}, **{d: 2 for d in PHASE['elem2']}}
    chart = {int(k): v for k, v in src['_phaseInChart'].items()}
    disagree = [{'d': d, 'timeline': official[d], 'chart': chart[d]}
                for d in range(1, 33) if official[d] != chart[d]]

    payload = {'source': 'SY 2025-26',
               'k5JespRoster': kj, 'k5CurrRoster': kc,
               'msJespRoster': mj, 'msCurrRoster': mc,
               'byDistrict': by, 'phaseDisagree': disagree}
    blob = json.dumps(payload)
    assert '@' not in blob, 'an email address reached the vendor payload'
    print('vendors (SY2025-26): %d K-5 providers, %d K-5 curricula, %d grades 6-8 providers; '
          'phase column disagrees with the launch timeline for %d districts'
          % (len(kj), len(kc), len(mj), len(disagree)))
    return payload


# ---------------------------------------------------------------------------
# Test refusals, by community school district.
#
# The three NYCPS results workbooks carry `Number Tested` and no enrolment
# denominator, so nothing in them can produce a participation or opt-out rate.
# The NYCPS InfoHub points to a "2026 ELA, Math and Science Results Summary"
# for "participation and results"; that document was read in full and carries
# proficiency only, no participation figure at any grain.
#
# NYSED publishes the measure instead, in its Refusals workbooks: for every
# district and charter, a count of students and the percent of them reported
# with a REFUSAL code. That is the right measure. Enrolled-minus-tested is not:
# taking the 32 districts together it was 15.3% in 2025 (13.1% in 2022), several
# times the refusal rate, because it also absorbs absence and every other reason
# a student did not sit. Note that is the citywide aggregate; the spread BETWEEN
# districts is much wider than the movement across years, 7.2% to 32.7% in 2025.
#
# Vintage: NYSED's district files follow local review and verification, and the
# latest published year is 2024-25. The series therefore ends at 2025, one year
# short of this tool's headline year. That is stated on the page rather than
# worked around.
# ---------------------------------------------------------------------------
ETH_CATS = ['Asian', 'Black', 'Hispanic', 'Multi-Racial', 'Native American', 'White']
GEN_CATS = ['Female', 'Male', 'Neither Female nor Male']


def read_demo_gap(path):
    """Citywide All Grades: All Students against the sum of the reported
    ethnicity and gender categories, per year.

    Read straight from the workbook. `Number Tested` is published even for
    groups whose level distribution is suppressed, so this is the honest
    measure of how far the demographic categories fall short of the total;
    summing the payload instead would count a fully suppressed group as
    missing and inflate the gap by its whole size.
    """
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)

    def tested(sheet):
        ws = wb[sheet]
        rows = ws.iter_rows(values_only=True)
        hdr = list(next(rows))
        H = {h: i for i, h in enumerate(hdr)}
        out = {}
        for r in rows:
            if r and r[H['Grade']] == 'All Grades':
                out[(r[H['Year']], r[H['Category']])] = r[H['Number Tested']]
        return out

    allg, eth, gen = tested('ELA - All'), tested('ELA - Ethnicity'), tested('ELA - Gender')
    out = {}
    for y in YEARS:
        a = allg[(y, 'All Students')]
        e = sum(eth[(y, c)] for c in ETH_CATS if isinstance(eth.get((y, c)), (int, float)))
        g = sum(gen[(y, c)] for c in GEN_CATS if isinstance(gen.get((y, c)), (int, float)))
        out[str(y)] = {'all': a, 'eth': e, 'gen': g, 'ethGap': a - e, 'genGap': a - g}
    return out


REFUSAL_YEARS = [2022, 2023, 2024, 2025]
REFUSAL_SUBS = [
    ('all',  'All students',                 4),
    ('ell',  'English Language Learners',    6),
    ('swd',  'Students with Disabilities',   8),
    ('econ', 'Economically Disadvantaged',  10),
]
REFUSAL_SRC = ('https://data.nysed.gov/downloads.php', 'NYSED, Districts and Charters '
               'Elementary and Middle Grades ELA, Math and Science Refusals')


def read_refusals(base):
    import re
    out_pct = {k: [[None]*len(REFUSAL_YEARS) for _ in DISTRICTS] for k, _, _ in REFUSAL_SUBS}
    out_n   = {k: [[None]*len(REFUSAL_YEARS) for _ in DISTRICTS] for k, _, _ in REFUSAL_SUBS}
    for yi, y in enumerate(REFUSAL_YEARS):
        path = os.path.join(base, 'nysed', 'ref%d.xlsx' % y)
        if not os.path.exists(path):
            print('WARNING: refusals source not found for %d, participation page will be empty' % y)
            return None
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        ws = wb['ELA']
        rows = list(ws.iter_rows(values_only=True))
        hdr = list(rows[1])
        # the sheet is two header rows: subgroup names above, field names below,
        # in fixed column pairs. Verify the pairs before trusting the offsets.
        assert hdr[2] == 'ENTITY_NAME', (path, hdr[:4])
        for _, _, col in REFUSAL_SUBS:
            assert hdr[col] == 'TOTAL_COUNT' and hdr[col+1] == '%_REFUSED', (path, col, hdr[col:col+2])
        seen = set()
        for r in rows[2:]:
            m = re.match(r'NYC GEOG DIST #\s*(\d+)\b', str(r[2] or '').upper())
            if not m:
                continue
            d = int(m.group(1))
            assert 1 <= d <= 32, (path, r[2])
            seen.add(d)
            for k, _, col in REFUSAL_SUBS:
                n, p = r[col], r[col+1]
                if not isinstance(n, (int, float)) or not isinstance(p, (int, float)):
                    continue            # suppressed or withheld; left null
                out_n[k][d-1][yi] = int(n)
                out_pct[k][d-1][yi] = round(float(p), 1)
        assert seen == set(range(1, 33)), (path, 'missing districts', sorted(set(range(1, 33)) - seen))
    filled = sum(1 for k in out_pct for row in out_pct[k] for v in row if v is not None)
    print('refusals: %d district-year-subgroup values over %s'
          % (filled, '-'.join(str(y) for y in (REFUSAL_YEARS[0], REFUSAL_YEARS[-1]))))
    return {'years': REFUSAL_YEARS,
            'subs': [{'k': k, 'label': lab} for k, lab, _ in REFUSAL_SUBS],
            'pct': out_pct, 'n': out_n,
            'src': REFUSAL_SRC[0], 'srcName': REFUSAL_SRC[1]}


# ---------------------------------------------------------------------------
# School-level results.
#
# Internal only. The file itself is public, published by NYCPS on the InfoHub
# alongside the city, borough and district files, but naming individual schools
# invites league-table readings that the district view does not, so it ships in
# the internal build only (see PUBLIC_INCLUDES_SCHOOLS in build.py).
#
# All Students only. The subgroup tabs exist, but 29.6% of school-level subgroup
# rows are suppressed against about 5% at district level, so the expensive
# option is mostly holes, concentrated in the small schools people most want to
# look at. All Students is 33,618 rows and about 1.3 MB; every subgroup across
# every year is 341,503 rows and 12.3 MB.
#
# The DBN carries the district in its first two characters, so schools group
# under their district for free. The file holds no charter schools and no
# District 75, matching the scope of the rest of the tool.
# ---------------------------------------------------------------------------
# Subgroups are carried for the comparable era only. All Students runs the full
# span because the trend charts use it; every other category starts at 2023,
# which is where any comparison can legitimately start anyway, and that alone
# is the difference between a 7 MB payload and a 13 MB one.
SCHOOL_SUBGROUP_FROM = 2023


def read_schools(path):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    idx, names, dists, out = {}, [], [], []
    kept = supp = 0
    for sn in SHEETS:
        if sn not in wb.sheetnames:
            continue
        ws = wb[sn]
        rows = ws.iter_rows(values_only=True)
        hdr = list(next(rows))
        H = {h: i for i, h in enumerate(hdr) if h}
        for c in ('DBN', 'School Name', 'Grade', 'Year', 'Category', 'Number Tested'):
            assert c in H, (path, sn, c, hdr)
        for r in rows:
            if r is None or r[0] is None:
                continue
            cat = r[H['Category']]
            if cat not in CI:
                continue
            if cat != 'All Students' and r[H['Year']] < SCHOOL_SUBGROUP_FROM:
                continue
            vals = [r[H[c]] for c in ['Number Tested', 'Mean Scale Score', '# Level 1',
                                      '# Level 2', '# Level 3', '# Level 4']]
            if any(v == 's' for v in vals):
                supp += 1
                continue
            if any(not isinstance(v, (int, float)) for v in vals):
                continue
            dbn = r[H['DBN']]
            if dbn not in idx:
                idx[dbn] = len(idx)
                names.append(str(r[H['School Name']]).strip())
                d = dbn[:2]
                dists.append(DISTRICTS.index(d) if d in DISTRICTS else -1)
            nt, ms, c1, c2, c3, c4 = vals
            assert c1 + c2 + c3 + c4 == nt, (dbn, r)
            out.append([idx[dbn], GI[str(r[H['Grade']])], YI[r[H['Year']]], CI[cat],
                        int(nt), round(float(ms), 6), int(c1), int(c2), int(c3), int(c4)])
            kept += 1
    out.sort()
    orphan = sum(1 for d in dists if d < 0)
    assert orphan == 0, '%d schools have a DBN outside districts 1-32' % orphan
    print('schools: %s rows over %s schools, %s categories (%s suppressed rows skipped)'
          % (f'{kept:,}', f'{len(idx):,}', len({r[3] for r in out}), f'{supp:,}'))
    return {'dbn': list(idx.keys()), 'name': names, 'dist': dists}, out


def read_map(path):
    """District outlines, pre-simplified to inline SVG paths by scripts/mkmap.py."""
    if not os.path.exists(path):
        print('WARNING: district outlines not found, the map will not render')
        return None
    m = json.load(open(path))
    assert set(m['paths']) == set(DISTRICTS), 'map paths do not cover all 32 districts'
    return m


def main():
    D = os.path.join(os.path.dirname(__file__), '..', 'data')
    city = read_level(os.path.join(D, 'citywide-ela-results-public.xlsx'), None)
    boro = read_level(os.path.join(D, 'borough-ela-results-public.xlsx'), 'Borough')
    dist = read_level(os.path.join(D, 'district-ela-results-public.xlsx'), 'District')

    boro = [[BORO_KEY[r[0]]] + r[1:] for r in boro]
    bidx = {b: i for i, b in enumerate(BOROS)}
    didx = {d: i for i, d in enumerate(DISTRICTS)}

    packed = {'city': pack(city, None), 'boro': pack(boro, bidx), 'dist': pack(dist, didx)}

    # ---- check: 'All Grades' row equals the sum of grades 3-8, wherever the
    #      six grade rows are all present (i.e. none suppressed).
    ag_bad = ag_tot = ag_part = 0
    for lvl, rows in packed.items():
        groups = {}
        for r in rows:
            groups.setdefault((r[0], r[2], r[3]), {})[r[1]] = r
        for k, g in groups.items():
            if GI['All Grades'] not in g:
                continue
            ag_tot += 1
            parts = [g[x] for x in range(6) if x in g]
            if len(parts) < 6:
                ag_part += 1
                continue
            for col in (4, 6, 7, 8, 9):
                if sum(p[col] for p in parts) != g[GI['All Grades']][col]:
                    ag_bad += 1
                    break
    assert ag_bad == 0, 'All Grades != sum(3-8) in %d groups' % ag_bad

    # ---- check: every district x year x grade cell exists for All Students
    exp = {(d, y, g) for d in range(32) for y in range(len(YEARS)) for g in range(7)}
    have = {(r[0], r[2], r[1]) for r in packed['dist'] if r[3] == CI['All Students']}
    missing = len(exp - have)
    assert missing == 0, 'missing district cells: %d' % missing

    # ---- reconciliation between the three files (All Students, All Grades)
    def total(rows, year):
        yi = YI[year]
        return sum(r[4] for r in rows
                   if r[1] == GI['All Grades'] and r[2] == yi and r[3] == CI['All Students'])
    recon = {str(y): {'city': total(packed['city'], y),
                      'boro': total(packed['boro'], y),
                      'dist': total(packed['dist'], y)} for y in YEARS}

    # ---- check: the three ELL categories are mutually exclusive and complete.
    #      This is what licenses labelling 'Ever ELL' as FORMER English Language
    #      Learners. If 'Ever' meant current-plus-former the three would
    #      over-count All Students by the size of 'Current ELL'.
    ell_bad = []
    for y in [2023, 2024, 2025, 2026]:
        yi = YI[y]

        def city_total(cat):
            return sum(r[4] for r in packed['city']
                       if r[1] == GI['All Grades'] and r[2] == yi and r[3] == CI[cat])
        a = city_total('All Students')
        s = sum(city_total(c) for c in ('Current ELL', 'Ever ELL', 'Never ELL'))
        if a != s:
            ell_bad.append((y, a, s))
    assert not ell_bad, 'ELL categories do not partition All Students: %r' % ell_bad

    # ---- demographic categories against the total. NYCPS attributes the
    #      shortfall to missing demographic information in the NYSED files.
    #      Read from the workbook rather than the payload: a row is dropped
    #      from the payload when any level count is suppressed, even where
    #      Number Tested is published, which would overstate the gap.
    demo_gap = read_demo_gap(os.path.join(D, 'citywide-ela-results-public.xlsx'))

    school_path = os.path.join(D, 'school-ela-results-public.xlsx')
    if os.path.exists(school_path):
        schools_meta, school_rows = read_schools(school_path)
    else:
        print('WARNING: school file not found, the schools page will be empty')
        schools_meta, school_rows = None, []

    checks = [
        {'name': 'Level counts sum to the number of students tested',
         'scope': 'every loaded row',
         'pass': True,
         'detail': '# Level 1 + 2 + 3 + 4 = Number Tested, exactly, in all %s rows.' % f"{stats['kept']:,}"},
        {'name': 'Published percentages match percentages recomputed from counts',
         'scope': 'every loaded row',
         'pass': True,
         'detail': 'Largest disagreement across all four levels: %.2e percentage points.' % DEV['pct']},
        {'name': 'Published % Level 3+4 matches Level 3 plus Level 4',
         'scope': 'every loaded row',
         'pass': True,
         'detail': 'Largest disagreement: %.2e percentage points; the counts agree exactly.' % DEV['p34']},
        {'name': 'The four level percentages sum to 100',
         'scope': 'every loaded row',
         'pass': True,
         'detail': 'Largest departure from 100: %.2e percentage points.' % DEV['sum100']},
        {'name': 'The All Grades row equals the sum of grades 3 to 8',
         'scope': 'every geography, year and student group',
         'pass': ag_bad == 0,
         'detail': '%s groups checked, %s failures. %s groups have at least one suppressed grade row; '
                   'for those the tool reads the All Grades row rather than summing.'
                   % (f'{ag_tot:,}', ag_bad, f'{ag_part:,}')},
        {'name': 'No district, year or grade is missing',
         'scope': 'district file, all students',
         'pass': missing == 0,
         'detail': '32 districts x 7 years x 7 grade rows = 1,568 cells, all present.'},
        {'name': 'The three files do not reconcile with each other',
         'scope': 'citywide vs borough vs district totals',
         'pass': True,
         'detail': 'Expected, and handled: in 2026 the district file totals %s tested students, the borough '
                   'file %s and the citywide file %s. Each level is read only from its own file.'
                   % (f"{recon['2026']['dist']:,}", f"{recon['2026']['boro']:,}", f"{recon['2026']['city']:,}")},
    ]

    inv_meta = {'citywide-ela-results-public.xlsx': ('2018–2026', 'New York City'),
                'borough-ela-results-public.xlsx': ('2018–2026', '5 boroughs'),
                'district-ela-results-public.xlsx': ('2018–2026', '32 community school districts')}
    inventory = [{'file': f, 'loaded': ld, 'suppressed': sp,
                  'years': inv_meta[f][0], 'geos': inv_meta[f][1],
                  'cats': len(CATS)} for f, ld, sp in INVENTORY]

    payload = {
        'years': YEARS,
        'grades': GRADES,
        'cats': CATS,
        'catLabels': [CAT_LABEL[c] for c in CATS],
        'catSheets': [CAT_SHEET[c] for c in CATS],
        'catNotes': [CAT_NOTE.get(c, '') for c in CATS],
        'refusals': read_refusals(D),
        'dims': [{'k': k, 'label': lab, 'cats': [CI[c] for c in cs]} for k, lab, cs in DIMS],
        'boros': BOROS,
        'districts': DISTRICTS,
        'districtBoro': [BORO_OF[d] for d in DISTRICTS],
        'phase': PHASE,
        'vendors': read_vendors(D),
        'schools': schools_meta,
        'school': school_rows,
        'map': read_map(os.path.join(D, 'district_paths.json')),
        'meta': {
            'rowsRead': stats['read'], 'rowsChecked': stats['kept'],
            'suppressed': stats['suppressed'],
            'checks': checks, 'inventory': inventory, 'recon': recon,
            'demoGap': demo_gap,
        },
        'city': packed['city'], 'boro': packed['boro'], 'dist': packed['dist'],
    }
    outp = os.path.join(D, 'payload.json')
    with open(outp, 'w') as f:
        json.dump(payload, f, separators=(',', ':'))
    print('stats', stats)
    print('max deviations', {k: '%.2e' % v for k, v in DEV.items()})
    print('AllGrades check: %d groups, %d failures, %d partial' % (ag_tot, ag_bad, ag_part))
    print('recon 2026', recon['2026'])
    print('rows city/boro/dist:', len(payload['city']), len(payload['boro']), len(payload['dist']))
    print('bytes', os.path.getsize(outp))
    print('ALL CHECKS PASSED')


if __name__ == '__main__':
    main()
