#!/usr/bin/env python3
"""Writes the sample and test RTF files.

usage: python3 scripts/make_samples.py <samplesDir> [--large <dir>] [--emf <file.emf>] [--wmf <file.wmf>]

<samplesDir> gets the small files (committed to the repo): Word-style report, WordPad notes, TextEdit files
(made with macOS textutil when it is there), three clinical-style tables, CJK text, pictures, and the hostile
files in hostile/. --large writes the 400-page book and the 50 MB file with pictures; those are never committed
(the gate deletes them in teardown).
"""
import os, sys, struct, zlib, subprocess, random, shutil, tempfile

args = sys.argv[1:]
out = args[0]
opt = {}
i = 1
while i < len(args):
    opt[args[i]] = args[i + 1]
    i += 2
os.makedirs(os.path.join(out, 'hostile'), exist_ok=True)


def w(name, data, base=out):
    p = os.path.join(base, name)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'wb') as f:
        f.write(data if isinstance(data, bytes) else data.encode('latin-1'))
    return p


def rtf_text(s):
    """Escapes text for RTF: specials, and non-ASCII as \\uN? (code units)."""
    o = []
    for ch in s:
        c = ord(ch)
        if ch in '\\{}':
            o.append('\\' + ch)
        elif ch == '\n':
            o.append('\\line ')
        elif ch == '\t':
            o.append('\\tab ')
        elif c < 128:
            o.append(ch)
        else:
            for unit in struct.unpack('<%dH' % (len(ch.encode('utf-16-le')) // 2), ch.encode('utf-16-le')):
                v = unit if unit < 32768 else unit - 65536
                o.append('\\u%d?' % v)
    return ''.join(o)


def png(wd, ht, fn):
    rows = b''.join(b'\x00' + bytes(v for x in range(wd) for v in fn(x, y)) for y in range(ht))
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', wd, ht, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows, 9)) + chunk(b'IEND', b'')


def chart_png():
    bars = [(40, (46, 117, 182)), (75, (237, 125, 49)), (55, (112, 173, 71)), (90, (91, 155, 213))]
    def px(x, y):
        if y >= 118 or x < 6:
            return (60, 60, 60) if (y == 118 or x == 6) else (255, 255, 255)
        k = (x - 14) // 36
        if 0 <= k < 4 and (x - 14) % 36 < 26 and 118 - y <= bars[k][0]:
            return bars[k][1]
        return (255, 255, 255) if y % 20 else (225, 225, 225)
    return png(160, 120, px)


def hexwrap(b, width=128):
    h = b.hex()
    return '\n'.join(h[i:i + width] for i in range(0, len(h), width))


def pict(b, kind, wg, hg, extra=''):
    tag = {'png': '\\pngblip', 'jpeg': '\\jpegblip', 'emf': '\\emfblip', 'wmf': '\\wmetafile8', 'dib': '\\dibitmap0', 'pict': '\\macpict'}[kind]
    return '{\\*\\shppict{\\pict' + tag + extra + '\\picwgoal%d\\pichgoal%d\n' % (wg, hg) + hexwrap(b) + '}}'


HEAD = ('{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1{\\fonttbl{\\f0\\froman\\fcharset0 Times New Roman;}{\\f1\\fswiss\\fcharset0 Calibri;}'
        '{\\f2\\fmodern\\fcharset0 Courier New;}{\\f3\\fswiss\\fcharset0 Arial;}{\\f4\\ftech\\fcharset2 Symbol;}}'
        '{\\colortbl;\\red0\\green0\\blue0;\\red31\\green78\\blue121;\\red192\\green0\\blue0;\\red0\\green112\\blue192;\\red255\\green255\\blue0;\\red217\\green226\\blue243;\\red242\\green242\\blue242;}'
        '{\\stylesheet{\\s0\\f1\\fs22 Normal;}{\\s1\\sb240\\sa60\\outlinelevel0\\b\\f1\\fs32\\cf2 heading 1;}{\\s2\\sb200\\sa60\\outlinelevel1\\b\\f1\\fs26\\cf2 heading 2;}{\\s15\\f1\\fs40 Title;}}'
        '{\\info{\\title %s}{\\author Zovo samples}}\\paperw12240\\paperh15840\\margl1440\\margr1440\\margt1440\\margb1440\n')


def h(level, text):
    return '\\pard\\plain\\s%d\\sb240\\sa80\\outlinelevel%d\\b\\f1\\fs%d\\cf2 %s\\par\n' % (level, level - 1, 32 if level == 1 else 26, rtf_text(text))


def para(text, extra=''):
    return '\\pard\\plain\\sa120\\sl276\\slmult1\\f1\\fs22' + extra + ' ' + text + '\\par\n'


def bullet(text, level=0):
    li = 720 + level * 360
    return '{\\listtext\\pard\\plain\\f4\\fs22 \\\'b7\\tab}\\pard\\plain\\li%d\\fi-360\\sa60\\f1\\fs22 %s\\par\n' % (li, text)


def numbered(n, text):
    return '{\\listtext\\pard\\plain\\f1\\fs22 %d.\\tab}\\pard\\plain\\li720\\fi-360\\sa60\\f1\\fs22 %s\\par\n' % (n, text)


def brd(sides, w=10):
    return ''.join('\\clbrdr%s\\brdrs\\brdrw%d' % (s, w) for s in sides)


def table(rows, widths, header_rows=1, shade_header=True, borders='tlbr', left=0, fs=20, center=False, extra_cell=None):
    """rows: list of lists of str (already RTF) or tuples (text, opts) with opts: mgf/mrg/vmgf/vmrg/al."""
    o = []
    for ri, r in enumerate(rows):
        o.append('\\trowd\\trgaph108\\trleft%d%s%s' % (left, '\\trhdr' if ri < header_rows else '', '\\trqc' if center else ''))
        x = left
        for ci, cell in enumerate(r):
            opts = cell[1] if isinstance(cell, tuple) else {}
            if opts.get('mgf'): o.append('\\clmgf')
            if opts.get('mrg'): o.append('\\clmrg')
            if opts.get('vmgf'): o.append('\\clvmgf')
            if opts.get('vmrg'): o.append('\\clvmrg')
            if opts.get('va'): o.append('\\clvertal' + opts['va'])
            b = opts.get('borders', borders)
            o.append(brd(b))
            if ri < header_rows and shade_header: o.append('\\clcbpat6')
            elif opts.get('shade'): o.append('\\clcbpat%d' % opts['shade'])
            x += widths[ci]
            o.append('\\cellx%d' % x)
        o.append('\n')
        for ci, cell in enumerate(r):
            text, opts = (cell if isinstance(cell, tuple) else (cell, {}))
            al = opts.get('al', '\\qc' if ri < header_rows else ('\\ql' if ci == 0 else '\\qc'))
            bold = '\\b' if ri < header_rows or opts.get('b') else ''
            o.append('\\pard\\plain\\intbl%s\\f1\\fs%d%s %s\\cell' % (al, fs, bold, text))
        o.append('\\row\n')
    o.append('\\pard\\plain\\f1\\fs22\\par\n')
    return ''.join(o)


# ---------- 1. welcome.rtf: Word-style report ----------
def welcome():
    chart = chart_png()
    s = HEAD % 'Quarterly field report'
    s += '{\\header\\pard\\plain\\qr\\f1\\fs18\\cf2 Northwind field office \\endash  quarterly report\\par}'
    s += '{\\footer\\pard\\plain\\qc\\f1\\fs18 Page {\\field{\\*\\fldinst PAGE}{\\fldrslt 1}} of {\\field{\\*\\fldinst NUMPAGES}{\\fldrslt 1}}\\par}'
    s += '\\pard\\plain\\s15\\qc\\sa120\\f1\\fs40\\cf2 Quarterly field report\\par\n'
    s += para('\\qc\\i Prepared for the regional board, third quarter')
    s += h(1, 'Summary')
    s += para('This report covers {\\b three sites} and {\\i 42 inspections}. Water quality met the target at every site, and the new sensors cut the time per inspection by {\\b\\cf3 18%}.{\\super\\chftn}{\\footnote\\pard\\plain\\f1\\fs18{\\super\\chftn} Measured over 42 inspections from July to September.}')
    s += para('Formatting check: {\\b bold}, {\\i italic}, {\\ul underlined}, {\\strike struck out}, {\\cf4 blue text}, {\\highlight5 highlighted}, H{\\sub 2}O, x{\\super 2}, {\\scaps Small Caps}, {\\f2 monospace code} and {\\fs32 large text}.')
    s += h(2, 'Key results')
    s += bullet('All three sites passed the spring water test.')
    s += bullet('Sensor uptime was 99.2% (target 98%).')
    s += bullet('Two pumps were replaced at the north site.', 1)
    s += numbered(1, 'Renew the sensor contract before December.')
    s += numbered(2, 'Train two more inspectors.')
    s += h(2, 'Inspections by site')
    rows = [['Site', 'Inspections', 'Passed', 'Pass rate'], ['North', '15', '14', '93%'], ['East', '12', '12', '100%'], ['South', '15', '15', '100%'], [('{\\b Total}', {'al': '\\ql'}), ('{\\b 42}', {}), ('{\\b 41}', {}), ('{\\b 98%}', {})]]
    s += table(rows, [2600, 2000, 2000, 2000])
    s += h(2, 'Inspections per month')
    s += '\\pard\\plain\\qc\\sa120 ' + pict(chart, 'png', 3600, 2700) + '\\par\n'
    s += para('\\qc\\i\\fs18 Figure 1. Inspections per month.')
    s += h(1, 'Next steps')
    s += para('The full data set is on the {\\field{\\*\\fldinst HYPERLINK "https://example.org/field-data"}{\\fldrslt {\\ul\\cf4 project page}}}. Questions go to {\\field{\\*\\fldinst HYPERLINK "mailto:field-office@example.org"}{\\fldrslt {\\ul\\cf4 the field office}}}.')
    s += '\\pard\\plain\\f1\\fs22\\page\n'
    s += h(1, 'Appendix: site notes')
    for k in range(1, 7):
        s += para('Note %d. The site was visited in week %d. Readings were taken at the inlet, the tank and the outlet, and each reading was logged with its time and the inspector\'s initials.' % (k, k + 26))
    s += '}'
    return w('welcome.rtf', s)


# ---------- 2. WordPad notes (Riched20 style) ----------
def wordpad():
    img = png(48, 48, lambda x, y: (255, 255, 255) if (x - 24) ** 2 + (y - 24) ** 2 > 400 else (0, 120, 212) if y < 30 else (0, 90, 160))
    s = ('{\\rtf1\\ansi\\ansicpg1252\\deff0\\nouicompat\\deflang1033{\\fonttbl{\\f0\\fnil\\fcharset0 Calibri;}{\\f1\\fnil\\fcharset0 Segoe UI;}{\\f2\\fnil\\fcharset2 Symbol;}}\n'
         '{\\colortbl ;\\red255\\green0\\blue0;\\red0\\green77\\blue187;\\red0\\green176\\blue80;}\n'
         '{\\*\\generator Riched20 10.0.19041}\\viewkind4\\uc1 \n'
         '\\pard\\sa200\\sl276\\slmult1\\b\\f1\\fs32\\lang9 Meeting notes\\b0\\f0\\fs22\\par\n'
         '\\i Tuesday, room 4\\i0\\par\n'
         '{\\pntext\\f2\\\'B7\\tab}{\\*\\pn\\pnlvlblt\\pnf2\\pnindent0{\\pntxtb\\\'B7}}\\fi-360\\li720\\sa200\\sl276\\slmult1 Budget: \\cf1\\b over by 4%\\cf0\\b0\\par\n'
         '{\\pntext\\f2\\\'B7\\tab}Hiring: \\cf2 two offers sent\\cf0\\par\n'
         '{\\pntext\\f2\\\'B7\\tab}Launch: \\cf3 on track\\cf0\\par\n'
         '\\pard\\sa200\\sl276\\slmult1 Logo for the slide deck:\\par\n'
         '{\\pict{\\*\\picprop}\\wmetafile8\\picw1270\\pich1270\\picwgoal720\\pichgoal720 \n010009000003}'
         '{\\pict\\pngblip\\picw48\\pich48\\picwgoal720\\pichgoal720\n' + hexwrap(img) + '}\\par\n'
         'Na\\\'efve caf\\\'e9 men\\\'fc: \\\'93quotes\\\'94 \\\'96 dashes \\\'85 and the euro sign \\\'80.\\par\n'
         '}\n')
    return w('wordpad-notes.rtf', s)


# ---------- 3. TextEdit files via textutil (the Cocoa RTF writer) ----------
def textedit():
    if not shutil.which('textutil'):
        print('textutil not found: TextEdit samples skipped')
        return
    tmp = tempfile.mkdtemp(prefix='rtfv-te-')
    letter = ('<html><body style="font-family: Helvetica"><h1 style="color:#1f4e79">Letter to the tenants</h1>'
              '<p>Dear tenants,</p><p>The <b>water</b> will be off on <i>Friday</i> from 9:00 to 12:00. '
              '<span style="color:#c00000">Please fill a jug the night before.</span></p>'
              '<ul><li>Building A: 9:00 to 10:00</li><li>Building B: 10:00 to 11:00</li><li>Building C: 11:00 to 12:00</li></ul>'
              '<ol><li>Turn off the boiler.</li><li>Close the main tap.</li></ol>'
              '<p style="text-align:right">Kind regards,<br>The caretaker</p>'
              '<p style="font-family: Menlo; font-size: 11px">Ref: WTR-2026-11</p></body></html>')
    tbl = ('<html><body style="font-family: Helvetica"><h2>Room booking</h2><table border="1" cellpadding="4" style="border-collapse:collapse">'
           '<tr><th>Room</th><th>Monday</th><th>Tuesday</th><th>Wednesday</th></tr>'
           '<tr><td>Blue</td><td>Team sync</td><td colspan="2" style="background:#e2efda">Workshop (two days)</td></tr>'
           '<tr><td>Green</td><td>Free</td><td>Interviews</td><td>Free</td></tr>'
           '<tr><td>Red</td><td style="color:#c00000"><b>Closed</b></td><td>Free</td><td>Board meeting</td></tr></table>'
           '<p>Book rooms on the wiki. Changes after Friday need a note to the office.</p></body></html>')
    for name, html in (('textedit-letter', letter), ('textedit-table', tbl)):
        src = os.path.join(tmp, name + '.html')
        open(src, 'w').write(html)
        subprocess.run(['textutil', '-convert', 'rtf', '-output', os.path.join(out, name + '.rtf'), src], check=True)
    shutil.rmtree(tmp)


# ---------- 4. clinical-style tables (layout of r2rtf / SAS ODS RTF output; written by this script) ----------
CL_HEAD = ('{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1{\\fonttbl{\\f0\\froman\\fcharset0 Times New Roman;}{\\f1\\fswiss\\fcharset0 Arial;}{\\f2\\fmodern\\fcharset0 Courier New;}}'
           '{\\colortbl;\\red0\\green0\\blue0;}\\paperw15840\\paperh12240\\margl1440\\margr1440\\margt1440\\margb1440\\landscape\\widowctrl\n'
           '{\\header\\pard\\plain\\ql\\f0\\fs18 Protocol ZV-2026-001\\tab\\tab\\tab\\tab\\tab\\tab\\tab\\tab\\tab Page {\\field{\\*\\fldinst PAGE}{\\fldrslt 1}} of {\\field{\\*\\fldinst NUMPAGES}{\\fldrslt 1}}\\par}\n'
           '{\\footer\\pard\\plain\\ql\\f0\\fs16 Source: /study/zv2026001/prog/%s.R   Generated 2026-11-08 09:14\\par}\n')


def cl_rows(title, sub, widths, header, body, foot):
    W = sum(widths)
    o = []
    for t in title:
        o.append('\\trowd\\trgaph108\\trleft0\\trqc\\trhdr\\cellx%d\n\\pard\\plain\\intbl\\qc\\f0\\fs18 %s\\cell\\row\n' % (W, rtf_text(t)))
    if sub:
        o.append(sub)
    o.append(header)
    for r in body:
        o.append(r)
    for f in foot:
        o.append('\\trowd\\trgaph108\\trleft0\\trqc\\clbrdrt\\brdrs\\brdrw15\\cellx%d\n\\pard\\plain\\intbl\\ql\\f0\\fs16 %s\\cell\\row\n' % (W, rtf_text(f)) if f is foot[0] else
                 '\\trowd\\trgaph108\\trleft0\\trqc\\cellx%d\n\\pard\\plain\\intbl\\ql\\f0\\fs16 %s\\cell\\row\n' % (W, rtf_text(f)))
    return ''.join(o)


def cl_line(cells, widths, top=False, bottom=False, aligns=None, hdr=False):
    o = ['\\trowd\\trgaph108\\trleft0\\trqc' + ('\\trhdr' if hdr else '')]
    x = 0
    for i, c in enumerate(cells):
        opts = c[1] if isinstance(c, tuple) else {}
        if opts.get('mgf'): o.append('\\clmgf')
        if opts.get('mrg'): o.append('\\clmrg')
        if opts.get('vmgf'): o.append('\\clvmgf')
        if opts.get('vmrg'): o.append('\\clvmrg')
        if top: o.append('\\clbrdrt\\brdrs\\brdrw15')
        if bottom or opts.get('bottom'): o.append('\\clbrdrb\\brdrs\\brdrw15')
        o.append('\\clvertalb')
        x += widths[i]
        o.append('\\cellx%d' % x)
    o.append('\n')
    for i, c in enumerate(cells):
        t = c[0] if isinstance(c, tuple) else c
        al = (aligns or [])[i] if aligns and i < len(aligns) else ('\\ql' if i == 0 else '\\qc')
        o.append('\\pard\\plain\\intbl%s\\f0\\fs18 %s\\cell' % (al, rtf_text(t)))
    o.append('\\row\n')
    return ''.join(o)


def clinical_demog():
    widths = [3600, 2200, 2200, 2200, 2200]
    hdr = (cl_line(['', ('Treatment group', {'mgf': True, 'bottom': True}), ('', {'mrg': True, 'bottom': True}), ('', {'mrg': True, 'bottom': True}), ''], widths, top=True, hdr=True) +
           cl_line(['Characteristic', 'Placebo\n(N=86)', 'Low dose\n(N=84)', 'High dose\n(N=84)', 'Total\n(N=254)'], widths, bottom=True, hdr=True))
    body = []
    random.seed(7)
    sections = [('Age (years)', [('n', '86', '84', '84', '254'), ('Mean (SD)', '75.2 (8.59)', '75.7 (8.29)', '74.4 (7.89)', '75.1 (8.25)'), ('Median', '76.0', '77.5', '76.0', '77.0'), ('Min, Max', '52, 89', '56, 88', '51, 88', '51, 89')]),
                ('Age group, n (%)', [('<65', '14 (16.3)', '8 (9.5)', '11 (13.1)', '33 (13.0)'), ('65-80', '42 (48.8)', '47 (56.0)', '55 (65.5)', '144 (56.7)'), ('>80', '30 (34.9)', '29 (34.5)', '18 (21.4)', '77 (30.3)')]),
                ('Sex, n (%)', [('Female', '53 (61.6)', '50 (59.5)', '40 (47.6)', '143 (56.3)'), ('Male', '33 (38.4)', '34 (40.5)', '44 (52.4)', '111 (43.7)')]),
                ('Race, n (%)', [('White', '78 (90.7)', '78 (92.9)', '74 (88.1)', '230 (90.6)'), ('Black or African American', '8 (9.3)', '6 (7.1)', '9 (10.7)', '23 (9.1)'), ('Other', '0', '0', '1 (1.2)', '1 (0.4)')])]
    for name, rows in sections:
        body.append(cl_line([name, '', '', '', ''], widths, aligns=['\\ql\\b'] * 5))
        for r in rows:
            body.append(cl_line(['    ' + r[0]] + list(r[1:]), widths))
    body[-1] = body[-1].replace('\\clvertalb', '\\clbrdrb\\brdrs\\brdrw15\\clvertalb')
    s = CL_HEAD % 'tlf_demog'
    s += cl_rows(['Table 14.1.1', 'Summary of Demographic and Baseline Characteristics', 'Safety Population'], '', widths, hdr, body,
                 ['Percentages are based on the number of subjects in each treatment group.', 'SD = standard deviation. Program: tlf_demog.R'])
    s += '\\pard\\plain\\f0\\fs18\\par}'
    return w('clinical-demographics.rtf', s)


def clinical_ae():
    widths = [5200, 2000, 2000, 2000, 2000]
    hdr = (cl_line(['System organ class', ('Number of subjects with events, n (%)', {'mgf': True, 'bottom': True}), ('', {'mrg': True, 'bottom': True}), ('', {'mrg': True, 'bottom': True}), ('', {'mrg': True, 'bottom': True})], widths, top=True, hdr=True) +
           cl_line(['    Preferred term', 'Placebo\n(N=86)', 'Low dose\n(N=84)', 'High dose\n(N=84)', 'Total\n(N=254)'], widths, bottom=True, hdr=True))
    socs = {'Gastrointestinal disorders': ['Diarrhoea', 'Nausea', 'Vomiting', 'Abdominal pain', 'Constipation'],
            'General disorders and administration site conditions': ['Application site pruritus', 'Application site erythema', 'Fatigue', 'Oedema peripheral', 'Pyrexia'],
            'Infections and infestations': ['Nasopharyngitis', 'Upper respiratory tract infection', 'Urinary tract infection', 'Influenza'],
            'Nervous system disorders': ['Dizziness', 'Headache', 'Syncope', 'Somnolence', 'Tremor'],
            'Skin and subcutaneous tissue disorders': ['Pruritus', 'Erythema', 'Rash', 'Hyperhidrosis', 'Skin irritation', 'Blister'],
            'Cardiac disorders': ['Sinus bradycardia', 'Myocardial infarction', 'Atrial fibrillation', 'Palpitations'],
            'Psychiatric disorders': ['Confusional state', 'Agitation', 'Insomnia', 'Anxiety']}
    random.seed(11)
    pages = []
    body = []
    count = 0
    for soc, pts in socs.items():
        n = [random.randint(5, 40) for _ in range(3)]
        body.append(cl_line([soc] + ['%d (%.1f)' % (v, v * 100 / d) for v, d in zip(n, (86, 84, 84))] + ['%d (%.1f)' % (sum(n), sum(n) * 100 / 254)], widths, aligns=['\\ql\\b'] + ['\\qc'] * 4))
        for pt in pts:
            m = [random.randint(0, 15) for _ in range(3)]
            body.append(cl_line(['    ' + pt] + ['%d (%.1f)' % (v, v * 100 / d) for v, d in zip(m, (86, 84, 84))] + ['%d (%.1f)' % (sum(m), sum(m) * 100 / 254)], widths))
        count += 1 + len(pts)
        if count > 18:
            pages.append(body); body = []; count = 0
    if body: pages.append(body)
    s = CL_HEAD % 'tlf_ae_soc'
    for k, b in enumerate(pages):
        b[-1] = b[-1].replace('\\clvertalb', '\\clbrdrb\\brdrs\\brdrw15\\clvertalb')
        s += cl_rows(['Table 14.3.1', 'Treatment-Emergent Adverse Events by System Organ Class and Preferred Term', 'Safety Population'], '', widths, hdr, b,
                     ['Subjects are counted once per system organ class and once per preferred term.', 'MedDRA version 27.0.'])
        if k < len(pages) - 1:
            s += '\\pard\\plain\\f0\\fs18\\page\n'
    s += '\\pard\\plain\\f0\\fs18\\par}'
    return w('clinical-ae.rtf', s)


def clinical_labs():
    widths = [2600, 2000, 1500, 1500, 1500, 1500, 1500, 1500]
    hdr = (cl_line(['Parameter', 'Baseline', ('Placebo', {'mgf': True, 'bottom': True}), ('', {'mrg': True, 'bottom': True}), ('', {'mrg': True, 'bottom': True}), ('High dose', {'mgf': True, 'bottom': True}), ('', {'mrg': True, 'bottom': True}), ('', {'mrg': True, 'bottom': True})], widths, top=True, hdr=True) +
           cl_line(['', '', 'Low', 'Normal', 'High', 'Low', 'Normal', 'High'], widths, bottom=True, hdr=True))
    random.seed(5)
    body = []
    for prm in ['Alanine aminotransferase (U/L)', 'Creatinine (umol/L)', 'Haemoglobin (g/L)', 'Potassium (mmol/L)']:
        for bi, base in enumerate(['Low', 'Normal', 'High']):
            first = ({'vmgf': True} if bi == 0 else {'vmrg': True})
            cells = [(prm if bi == 0 else '', first), base] + [str(random.randint(0, 60)) for _ in range(6)]
            body.append(cl_line(cells, widths, bottom=(bi == 2)))
    s = CL_HEAD % 'tlf_lab_shift'
    s += cl_rows(['Table 14.3.4', 'Shift from Baseline to Worst Post-baseline Value in Laboratory Parameters', 'Safety Population'], '', widths, hdr, body,
                 ['Low/Normal/High relative to the reference range of the central laboratory.'])
    s += '\\pard\\plain\\f0\\fs18\\par}'
    return w('clinical-lab-shift.rtf', s)


# ---------- 5. CJK text: code pages and \\u escapes ----------
def cjk():
    def b(text, enc):
        return ''.join('\\\'%02x' % c if c > 127 or c in (0x5c, 0x7b, 0x7d) else chr(c) for c in text.encode(enc))
    s = ('{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1{\\fonttbl{\\f0\\fswiss\\fcharset0 Arial;}{\\f1\\fnil\\fcharset128 MS Mincho;}{\\f2\\fnil\\fcharset134 SimSun;}'
         '{\\f3\\fnil\\fcharset136 PMingLiU;}{\\f4\\fnil\\fcharset129 Malgun Gothic;}{\\f5\\fnil\\fcharset204 Arial Cyr;}{\\f6\\fnil\\fcharset161 Arial Greek;}}\n'
         '\\pard\\plain\\sa120\\f0\\fs28\\b Languages and code pages\\b0\\fs22\\par\n'
         '\\pard\\plain\\sa80\\f0\\fs22 Japanese, Shift-JIS bytes: {\\f1 ' + b('日本語のテキスト、東京都。', 'shift_jis') + '}\\par\n'
         '\\pard\\plain\\sa80\\f0\\fs22 Chinese simplified, GBK bytes: {\\f2 ' + b('简体中文文本，北京市。', 'gbk') + '}\\par\n'
         '\\pard\\plain\\sa80\\f0\\fs22 Chinese traditional, Big5 bytes: {\\f3 ' + b('繁體中文文字，臺北市。', 'big5') + '}\\par\n'
         '\\pard\\plain\\sa80\\f0\\fs22 Korean, code page 949 bytes: {\\f4 ' + b('한국어 텍스트, 서울특별시.', 'cp949') + '}\\par\n'
         '\\pard\\plain\\sa80\\f0\\fs22 Russian, code page 1251: {\\f5 ' + b('Русский текст, Москва.', 'cp1251') + '}\\par\n'
         '\\pard\\plain\\sa80\\f0\\fs22 Greek, code page 1253: {\\f6 ' + b('Ελληνικό κείμενο, Αθήνα.', 'cp1253') + '}\\par\n'
         '\\pard\\plain\\sa80\\f0\\fs22 Unicode escapes with fallback: {\\f1\\uc2 \\u26085\\\'93\\\'fa\\u26412\\\'96\\\'7b\\u35486\\\'8c\\\'ea} and emoji ' + rtf_text('🙂 ✓') + '\\par\n'
         '\\pard\\plain\\sa80\\f0\\fs22 Mixed line: Tokyo ' + rtf_text('東京') + ', Seoul ' + rtf_text('서울') + ', Kyiv ' + rtf_text('Київ') + ', Cairo ' + rtf_text('القاهرة') + '.\\par\n}')
    return w('cjk-languages.rtf', s)


# ---------- 6. pictures ----------
def pictures():
    chart = chart_png()
    jpg = None
    if shutil.which('sips'):
        tmp = tempfile.mkdtemp(prefix='rtfv-jpg-')
        p = os.path.join(tmp, 'a.png')
        open(p, 'wb').write(png(200, 120, lambda x, y: (x % 256, (x + y) % 256, 255 - y % 256)))
        subprocess.run(['sips', '-s', 'format', 'jpeg', p, '--out', os.path.join(tmp, 'a.jpg')], check=True, capture_output=True)
        jpg = open(os.path.join(tmp, 'a.jpg'), 'rb').read()
        shutil.rmtree(tmp)
    # 24-bit DIB 32x16
    wd, ht = 32, 16
    rowsz = (wd * 3 + 3) & ~3
    pix = b''.join(bytes(v for x in range(wd) for v in ((x * 8) % 256, 64, 255 - x * 8)) + b'\x00' * (rowsz - wd * 3) for y in range(ht))
    dib = struct.pack('<IiiHHIIiiII', 40, wd, ht, 1, 24, 0, len(pix), 2835, 2835, 0, 0) + pix
    s = HEAD % 'Pictures'
    s += h(1, 'Pictures in RTF')
    s += para('PNG chart:') + '\\pard\\plain ' + pict(chart, 'png', 2400, 1800) + '\\par\n'
    if jpg:
        s += para('JPEG photo:') + '\\pard\\plain ' + pict(jpg, 'jpeg', 3000, 1800) + '\\par\n'
    if opt.get('--emf'):
        emf = open(opt['--emf'], 'rb').read()
        s += para('EMF drawing (Windows metafile):') + '\\pard\\plain ' + pict(emf, 'emf', 2880, 1440) + '\\par\n'
    if opt.get('--wmf'):
        wmf = open(opt['--wmf'], 'rb').read()
        if wmf[:4] == b'\xd7\xcd\xc6\x9a':
            wmf = wmf[22:]  # RTF stores WMF without the placeable header
        s += para('WMF picture:') + '\\pard\\plain ' + pict(wmf, 'wmf', 2880, 1440, '\\picw5080\\pich2540') + '\\par\n'
    s += para('DIB bitmap:') + '\\pard\\plain ' + pict(dib, 'dib', 960, 480, '\\picw32\\pich16') + '\\par\n'
    s += para('Mac PICT (no browser can show it, so a labelled box):') + '\\pard\\plain ' + pict(b'\x00' * 64, 'pict', 1440, 720) + '\\par\n'
    s += para('Picture inside a table:')
    s += table([['Chart', 'Notes'], ['\\pard\\plain\\intbl ' + pict(chart, 'png', 1600, 1200), 'The cell holds a PNG.']], [3000, 4000])
    s += '}'
    return w('pictures.rtf', s)


# ---------- 7. hostile files ----------
def hostile():
    hd = os.path.join(out, 'hostile')
    # 100,000-deep nesting
    w('deep-nesting.rtf', '{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\f0 Before the deep part.\\par ' + '{' * 100000 + 'deep text' + '}' * 100000 + '\\par After the deep part.\\par}', hd)
    # \binN with N larger than the file
    w('bin-overflow.rtf', '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\f0 Text before the picture.\\par {\\pict\\pngblip\\picwgoal1440\\pichgoal1440\\bin999999999 \x89PNG\r\n\x1a\n short}}', hd)
    # \objdata OLE blob (bytes of an OLE compound file header and a fake executable name)
    ole = bytes.fromhex('d0cf11e0a1b11ae1') + b'\x00' * 24 + b'Package\x00calc.exe\x00C:\\Windows\\System32\\calc.exe\x00' + b'MZ\x90\x00' + os.urandom(512)
    w('ole-object.rtf', '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\f0 An embedded package object follows.\\par '
      '{\\object\\objemb{\\*\\objclass Package}\\objw1440\\objh1440{\\*\\objdata 01050000020000000800000050616' + ole.hex() + '}'
      '{\\result{\\pict\\pngblip\\picwgoal720\\pichgoal720 ' + png(16, 16, lambda x, y: (200, 0, 0)).hex() + '}}}\\par After the object.\\par}', hd)
    # links with javascript:, data:, file: and vbscript: targets, plus markup in the text
    w('javascript-link.rtf', '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\f0 '
      '{\\field{\\*\\fldinst HYPERLINK "javascript:alert(document.cookie)"}{\\fldrslt {\\ul Click for a prize}}}\\par '
      '{\\field{\\*\\fldinst HYPERLINK "  JaVa\tScript:alert(1)"}{\\fldrslt {\\ul Second javascript link}}}\\par '
      '{\\field{\\*\\fldinst HYPERLINK "data:text/html,<script>alert(1)</script>"}{\\fldrslt {\\ul Data link}}}\\par '
      '{\\field{\\*\\fldinst HYPERLINK "file:///etc/passwd"}{\\fldrslt {\\ul File link}}}\\par '
      '{\\field{\\*\\fldinst HYPERLINK "vbscript:msgbox(1)"}{\\fldrslt {\\ul VBScript link}}}\\par '
      'Markup as text: <script>window.pwned=1</script> <img src=x onerror="window.pwned=2"> <iframe src="https://example.com"></iframe>\\par '
      '{\\field{\\*\\fldinst HYPERLINK "https://example.org/safe"}{\\fldrslt {\\ul A normal web link}}}\\par}', hd)
    # code page that does not exist and a broken font charset
    w('bad-codepage.rtf', '{\\rtf1\\ansi\\ansicpg99999\\deff0{\\fonttbl{\\f0\\fcharset250 Nowhere;}{\\f1\\fcharset0 Arial;}}\\f0 Bytes \\\'e9\\\'e8\\\'ff in an unknown code page.\\par\\f1 Arial line: caf\\\'e9.\\par}', hd)
    # 0-byte file
    w('empty.rtf', b'', hd)
    # not RTF at all, with an .rtf name
    w('not-rtf.rtf', '<html><body><script>alert(1)</script>Not RTF</body></html>', hd)


# ---------- 8. large files ----------
def large(d):
    os.makedirs(d, exist_ok=True)
    # 400 pages: each page a heading, two paragraphs and a small table
    parts = [HEAD % 'Generated 400-page book']
    for p in range(1, 401):
        parts.append(h(1, 'Chapter %d' % p))
        for k in range(3):
            parts.append(para('Page %d, paragraph %d. The quick brown fox jumps over the lazy dog while the committee reviews the minutes of meeting number %d, and the clerk files the notes in drawer %d.' % (p, k + 1, p * 3 + k, p % 17)))
        parts.append(table([['Item', 'Value'], ['Page', str(p)], ['Square', str(p * p)]], [3000, 3000], fs=18))
        if p < 400:
            parts.append('\\pard\\plain\\page\n')
    parts.append('}')
    w('book-400-pages.rtf', ''.join(parts), d)
    # about 52 MB with pictures: noise PNGs (do not compress) between text
    random.seed(3)
    parts = [HEAD % 'Large file with pictures', h(1, 'Large file with pictures')]
    size = 0
    k = 0
    target = 52 * 1024 * 1024
    while size < target:
        k += 1
        noise = png(300, 300, lambda x, y: (random.randrange(256), random.randrange(256), random.randrange(256)))
        block = h(2, 'Picture %d' % k) + para('Text before picture %d.' % k) + '\\pard\\plain ' + pict(noise, 'png', 2000, 2000) + '\\par\n'
        parts.append(block)
        size += len(block)
    parts.append(para('The end of the large file.') + '}')
    w('large-52mb-pictures.rtf', ''.join(parts), d)


welcome(); wordpad(); textedit(); clinical_demog(); clinical_ae(); clinical_labs(); cjk(); pictures(); hostile()
if opt.get('--large'):
    large(opt['--large'])
for root, _, files in os.walk(out):
    for f in sorted(files):
        print('%9d %s' % (os.path.getsize(os.path.join(root, f)), os.path.relpath(os.path.join(root, f), out)))
