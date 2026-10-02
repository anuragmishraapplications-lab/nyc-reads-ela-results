import json, os, datetime, re, sys

R = os.path.join(os.path.dirname(__file__), '..')

# ---------------------------------------------------------------------------
# Two builds.
#
#   public   (default)  the providers page is removed AND the provider and
#                       curriculum assignments are stripped out of the data
#                       payload entirely. The information is not in the file.
#   internal (--internal) the full tool.
#
# This is the only way to restrict that data in a static page. A password
# prompt in the browser would not restrict anything: the file is delivered
# whole to whoever opens it, so the assignments would still be readable in the
# page source no matter what the prompt did. Removing the data is the control.
# ---------------------------------------------------------------------------
INTERNAL = '--internal' in sys.argv

# ---------------------------------------------------------------------------
# Provider and curriculum assignments in the PUBLIC build.
#
# These are two separate fields and they are treated separately. The adopted
# CURRICULUM (EL, HMH, Wit and Wisdom) stays in the public build: NYCPS asked
# for those filters to be kept. The professional learning PROVIDER, the JESP,
# is withheld.
#
# Note that a name can be both. EL, HMH and Great Minds appear as providers,
# and EL, HMH and Wit and Wisdom appear as curricula, so the public build
# cannot be verified simply by grepping for a publisher name. The check below
# probes only the names that are providers and nothing else.
#
# Hiding the provider page is only half the control: the assignments also live
# in data/payload.json and the two vendor JSONs, which is why those files are
# gitignored rather than committed.
# ---------------------------------------------------------------------------
PUBLIC_INCLUDES_PROVIDERS  = False
PUBLIC_INCLUDES_CURRICULUM = True

tpl   = open(os.path.join(R,'src/template.html')).read()
app   = open(os.path.join(R,'src/app.js')).read()
chart = open(os.path.join(R,'vendor/chart.umd.min.js')).read()
logo_nycreads = open(os.path.join(R,'data/nycreads_logo_b64.txt')).read().strip()
logo_cprl     = open(os.path.join(R,'data/cprl_formal_b64.txt')).read().strip()
payload_obj   = json.load(open(os.path.join(R,'data/payload.json')))
build = datetime.date(2026,10,2).strftime('%-d %B %Y')

if not INTERNAL:
    v = payload_obj.get('vendors')
    if v and not PUBLIC_INCLUDES_PROVIDERS:
        # empty the provider rosters and clear the per-district provider keys.
        # The app treats an empty roster as "this field does not exist here",
        # so the group-by option, the roster table and the filter all drop out
        # without any of them needing to know why.
        v['k5JespRoster'] = []
        v['msJespRoster'] = []
        for rec in v.get('byDistrict', []):
            rec['kj'] = None
            rec['mj'] = None
    if v and not PUBLIC_INCLUDES_CURRICULUM:
        v['k5CurrRoster'] = []
        v['msCurrRoster'] = []
        for rec in v.get('byDistrict', []):
            rec['kc'] = None
            rec['mc'] = None
    if v and not (PUBLIC_INCLUDES_PROVIDERS or PUBLIC_INCLUDES_CURRICULUM):
        # nothing left to show: drop the page and its nav entry entirely
        payload_obj.pop('vendors', None)
        tpl = re.sub(r'\s*<div class="ni" data-p="ve">.*?</div>\n', '\n', tpl, flags=re.S)
        i = tpl.index('<!-- ============ PROVIDERS AND CURRICULUM ============ -->')
        j = tpl.index('<!-- ============ SUBGROUPS ============ -->')
        tpl = tpl[:i] + tpl[j:]
        for host in ('di-ms-reads','di-ms-curr','bo-ms-reads','bo-ms-curr'):
            tpl = re.sub(r'\s*<div class="fg"><span class="fl">[^<]*</span><div id="%s"></div></div>' % host,
                         '', tpl)

payload = json.dumps(payload_obj, separators=(',',':'))

for name, blob in [('payload', payload)]:
    assert '__PAYLOAD__' not in blob and '</script' not in blob.lower(), name

out = tpl
out = out.replace('__LOGO_NYCREADS__', logo_nycreads)
out = out.replace('__LOGO_CPRL__', logo_cprl)
out = out.replace('__PAYLOAD__', payload)
out = out.replace('__APP__', app)
out = out.replace('__BUILD__', build)
out = out.replace('__BUILDKIND__', 'internal' if INTERNAL else 'public')
out = out.replace('__CHARTJS__', chart)
for tok in ('PAYLOAD','APP','LOGO_NYCREADS','LOGO_CPRL','BUILD','BUILDKIND','CHARTJS'):
    assert '__' + tok + '__' not in out, 'unreplaced token: ' + tok

name = 'NYC_Reads_ELA_Dashboard_INTERNAL.html' if INTERNAL else 'NYC_Reads_ELA_Dashboard.html'
p = os.path.join(R, name)
open(p,'w').write(out)

# the public build must not carry withheld assignment values anywhere
if not INTERNAL and not PUBLIC_INCLUDES_PROVIDERS:
    low = out.lower()
    # names that identify a PROVIDER and nothing else. EL, HMH and Wit and
    # Wisdom are deliberately absent from this list: they are curriculum values
    # the public build is meant to carry.
    # matched on word boundaries, not as bare substrings: "relay" occurs inside
    # Chart.js's own beforeLayout, and a substring test fails on that
    for probe in ('teaching matters','teaching lab','generation ready','leading educators',
                  'k12 coalition','great minds','relay','cs4as',
                  'center for student achievement','keys to literacy',
                  'curriculum associates','bank street'):
        hit = re.search(r'\b' + re.escape(probe) + r'\b', low)
        assert not hit, ('withheld provider name reached the public build: %s (near %r)'
                         % (probe, low[max(0,hit.start()-60):hit.end()+60]))
    print('public build: provider names absent, verified'
          + ('; curriculum retained' if PUBLIC_INCLUDES_CURRICULUM else ''))

print('wrote', p, f'{os.path.getsize(p)/1e6:.2f} MB')
