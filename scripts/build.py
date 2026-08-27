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
# Withheld from the public file. Briefly published on 17 August 2026 at NYCPS's
# request, then withdrawn again on 21 August 2026. Note that hiding the page is
# only half the control: the assignments also live in data/payload.json and the
# two vendor JSONs, which are why those files are gitignored rather than
# committed. A public build with the page stripped and the payload committed
# would leak the same data through the repository.
# ---------------------------------------------------------------------------
PUBLIC_INCLUDES_VENDORS = False

tpl   = open(os.path.join(R,'src/template.html')).read()
app   = open(os.path.join(R,'src/app.js')).read()
chart = open(os.path.join(R,'vendor/chart.umd.min.js')).read()
logo_nycreads = open(os.path.join(R,'data/nycreads_logo_b64.txt')).read().strip()
logo_cprl     = open(os.path.join(R,'data/cprl_formal_b64.txt')).read().strip()
payload_obj   = json.load(open(os.path.join(R,'data/payload.json')))
build = datetime.date(2026,8,17).strftime('%-d %B %Y')

if not INTERNAL and not PUBLIC_INCLUDES_VENDORS:
    # strip the restricted data from the payload
    payload_obj.pop('vendors', None)
    # drop the providers page markup and its nav entry
    tpl = re.sub(r'\s*<div class="ni" data-p="ve">.*?</div>\n', '\n', tpl, flags=re.S)
    i = tpl.index('<!-- ============ PROVIDERS AND CURRICULUM ============ -->')
    j = tpl.index('<!-- ============ SUBGROUPS ============ -->')
    tpl = tpl[:i] + tpl[j:]
    # the provider and curriculum filters would otherwise sit empty
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

# the public build must not carry provider or curriculum information anywhere
if not INTERNAL and not PUBLIC_INCLUDES_VENDORS:
    low = out.lower()
    # the actual assignment values. "JESP" and "provider" are role words and
    # may appear; the names of providers and curricula may not.
    for probe in ('teaching matters','teaching lab','generation ready','leading educators',
                  'k12 coalition','great minds','wit and wisdom','keys to literacy',
                  'student achievement solutions','curriculum associates','bank street'):
        assert probe not in low, 'restricted term reached the public build: ' + probe
    print('public build: provider and curriculum data absent, verified')

print('wrote', p, f'{os.path.getsize(p)/1e6:.2f} MB')
