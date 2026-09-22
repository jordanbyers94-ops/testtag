// Builds the "Test Register" .docx report matching Aus Air Electrical's existing report
// template (see the uploaded sample: cover page, inspection details/summary, register table).
// Pure server-side generation via the `docx` npm package -- no Word/LibreOffice needed.

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, WidthType, Footer, PageBreak, ShadingType, VerticalAlign, ImageRun,
} = require('docx');
const LOGO_BASE64 = require('./report_logo');

const BRAND_ORANGE = 'F5A623';
const BRAND_BLACK = '1A1A1A';
const BRAND_GRAY = '666666';
const FAIL_RED = 'C0392B';
const UNFOUND_GRAY = '999999';

const CONTACT = {
  mobile: '0412 807 125',
  phone: '3358 1541',
  fax: '3254 1863',
  address: '179 Annie St, New Farm QLD Australia 4005',
  email: 'accounts@ausairelectrical.com.au',
  web: 'www.ausairelectrical.com.au',
  abn: '91 128 203 270',
  licence: '69969',
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function toDateObj(d) {
  if (!d) return null;
  if (d instanceof Date) return d;
  if (typeof d === 'string') return new Date(d.length === 10 ? d + 'T00:00:00Z' : d);
  return null;
}
function formatDMY(d) {
  const dt = toDateObj(d);
  if (!dt || isNaN(dt)) return 'N/A';
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${dt.getUTCFullYear()}`;
}
function formatLong(d) {
  const dt = toDateObj(d);
  if (!dt || isNaN(dt)) return '';
  return `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
}
function joinList(items) {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return items.join(' and ');
  return items.slice(0, -1).join(', ') + ', and ' + items[items.length - 1];
}

function kv(label, value) {
  return new Paragraph({ spacing: { after: 40 }, children: [
    new TextRun({ text: label + ' ', bold: true, size: 22 }),
    new TextRun({ text: value, size: 22 }),
  ] });
}
function heading(text) {
  return new Paragraph({ spacing: { before: 300, after: 120 }, children: [
    new TextRun({ text, bold: true, size: 24, color: BRAND_BLACK }),
  ] });
}
function bullet(text) {
  return new Paragraph({ text, bullet: { level: 0 }, spacing: { after: 40 } });
}

function footer() {
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 100 },
        children: [
          new TextRun({ text: `M ${CONTACT.mobile}   `, size: 14, color: BRAND_ORANGE, bold: true }),
          new TextRun({ text: `P ${CONTACT.phone}   `, size: 14, color: BRAND_BLACK }),
          new TextRun({ text: `F ${CONTACT.fax}   `, size: 14, color: BRAND_BLACK }),
          new TextRun({ text: `Address: ${CONTACT.address}`, size: 14, color: BRAND_BLACK }),
        ],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ text: `E ${CONTACT.email}   `, size: 14, color: BRAND_ORANGE }),
          new TextRun({ text: `W ${CONTACT.web}   `, size: 14, color: BRAND_BLACK }),
          new TextRun({ text: `ABN: ${CONTACT.abn}   `, size: 14, color: BRAND_BLACK }),
          new TextRun({ text: `Electrical Contractors Licence: ${CONTACT.licence}`, size: 14, color: BRAND_BLACK }),
        ],
      }),
    ],
  });
}

// scopeType/scopeValue generalize the report's grouping to be either a Site (the original,
// still-default behaviour) or a Job Number (a per-visit job reference used exactly like Site --
// handy for mobile test & tag work spanning multiple locations/vehicles under one job). Either
// way scopeValue is the single string that identifies "this visit" in the narrative text.
function scopeLabel(scopeType) { return scopeType === 'job_number' ? 'Job Number' : 'Site'; }
function scopeNarrative({ scopeType, scopeValue }) {
  return scopeType === 'job_number' ? `Job Number ${scopeValue}` : scopeValue;
}

function buildCoverPage({ testDate, scopeType, scopeValue, clientName }) {
  const narrative = scopeNarrative({ scopeType, scopeValue });
  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 1600, after: 150 },
      children: [
        new ImageRun({
          type: 'png',
          data: Buffer.from(LOGO_BASE64, 'base64'),
          transformation: { width: 70, height: 62 },
        }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 500 },
      children: [
        new TextRun({ text: 'AUS', bold: true, color: BRAND_ORANGE, size: 28 }),
        new TextRun({ text: 'AIR ', bold: true, color: BRAND_BLACK, size: 28 }),
        new TextRun({ text: 'ELECTRICAL', bold: true, color: BRAND_BLACK, size: 28 }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [new TextRun({ text: 'TEST REGISTER', bold: true, color: BRAND_ORANGE, size: 56 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: clientName ? 60 : 700 },
      children: [new TextRun({ text: scopeValue, size: 32, color: BRAND_BLACK })],
    }),
    ...(clientName ? [new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 700 },
      children: [new TextRun({ text: clientName, size: 22, color: BRAND_GRAY })],
    })] : []),
    new Paragraph({
      spacing: { before: 600, after: 100 },
      children: [new TextRun({ text: 'Abstract', bold: true, size: 22 })],
    }),
    new Paragraph({
      children: [new TextRun({
        text: `Testing and tagging of portable electrical equipment, together with RCD push-button testing, was carried out in accordance with AS 3760:2022 at ${narrative} on ${formatLong(testDate)}.`,
        size: 22,
      })],
    }),
    new Paragraph({ spacing: { before: 2400 }, children: [new TextRun({ text: 'Aus Air Electrical Pty Ltd', bold: true, size: 22 })] }),
    new Paragraph({ children: [new TextRun({ text: CONTACT.email, size: 20, color: BRAND_GRAY })] }),
    new Paragraph({ children: [new PageBreak()] }),
  ];
}

function complianceStatement({ total, passedAssets, failedAssets, unfoundAssets, passedDueDates }) {
  let s = `Of ${total} item${total === 1 ? '' : 's'} inspected, ${passedAssets.length} passed`;
  if (passedDueDates.size === 1) s += ` and were tagged with the next scheduled test date of ${[...passedDueDates][0]}`;
  s += '.';
  if (failedAssets.length) {
    s += ` ${failedAssets.length === 1 ? 'One item failed' : failedAssets.length + ' items failed'}`;
    const usItems = failedAssets.filter((f) => /u\/s|unserviceable/i.test(f.test.notes || ''));
    if (usItems.length) {
      s += `, including ${usItems.length === 1 ? '1 unserviceable item' : usItems.length + ' unserviceable items'} (${usItems.map((f) => f.asset.appliance || 'item').join(', ')})`;
    }
    s += '.';
  }
  if (unfoundAssets.length) {
    s += ` ${unfoundAssets.length} item${unfoundAssets.length === 1 ? ' was' : 's were'} unfound.`;
  }
  s += ' Compliant items were tagged, failed items scheduled for corrective action, and unserviceable equipment removed from service.';
  return s;
}

function buildDetailsPage({ testDate, assets, testByAssetId, scopeType, scopeValue, clientName }) {
  const total = assets.length;
  const passedAssets = [];
  const failedAssets = [];
  const unfoundAssets = [];
  const testerCounts = {};
  const passedDueDates = new Set();
  const applianceCounts = {};

  for (const a of assets) {
    const t = testByAssetId[a.id];
    if (!t) { unfoundAssets.push(a); continue; }
    if (t.tester_name) testerCounts[t.tester_name] = (testerCounts[t.tester_name] || 0) + 1;
    if (t.result === 'fail') { failedAssets.push({ asset: a, test: t }); continue; }
    passedAssets.push({ asset: a, test: t });
    if (t.next_due) passedDueDates.add(formatDMY(t.next_due));
    const appliance = (a.appliance || '').trim();
    if (appliance) applianceCounts[appliance] = (applianceCounts[appliance] || 0) + 1;
  }

  const inspector = Object.keys(testerCounts).sort((a, b) => testerCounts[b] - testerCounts[a])[0] || '—';

  const children = [];
  children.push(kv('Inspection Type:', 'Electrical Safety Testing'));
  children.push(kv('Tests Performed:', 'AS/NZS 3760:2022'));
  ['Visual Electrical Safety Inspection', 'Earth Continuity', 'Insulation Resistance'].forEach((t) => children.push(bullet(t)));
  children.push(kv('Test Date:', formatDMY(testDate)));
  children.push(kv(scopeLabel(scopeType) + ':', scopeValue));
  if (clientName) children.push(kv('Client:', clientName));
  children.push(kv('Inspector:', inspector));

  children.push(heading('Summary of Results'));
  children.push(bullet(`Total items inspected: ${total}`));
  children.push(bullet(`Pass: ${passedAssets.length}`));
  children.push(bullet(`Fail: ${failedAssets.length}`));
  children.push(bullet(`Unfound: ${unfoundAssets.length}`));

  if (passedAssets.length) {
    children.push(heading('Items Passed'));
    const topAppliances = Object.keys(applianceCounts).sort((a, b) => applianceCounts[b] - applianceCounts[a]).slice(0, 7);
    if (topAppliances.length) {
      children.push(bullet(`Majority of portable equipment including ${joinList(topAppliances.map((s) => s.toLowerCase()))} passed inspection.`));
    } else {
      children.push(bullet('Majority of portable equipment passed inspection.'));
    }
    if (passedDueDates.size === 1) {
      children.push(bullet(`All passed items were tagged with the next scheduled test date of ${[...passedDueDates][0]}.`));
    } else if (passedDueDates.size > 1) {
      children.push(bullet(`Passed items were tagged with next scheduled test dates of ${joinList([...passedDueDates])}.`));
    }
  }

  if (failedAssets.length) {
    children.push(heading('Items Failed'));
    for (const { asset, test } of failedAssets) {
      const desc = asset.appliance || 'Item';
      const reason = test.notes ? test.notes : 'corrective action required';
      children.push(bullet(`Plant No. ${asset.plant_no || '—'} – ${desc} (Fail – ${reason})`));
    }
  }

  if (unfoundAssets.length) {
    children.push(heading('Items Unfound'));
    for (const a of unfoundAssets) {
      children.push(bullet(`Plant No. ${a.plant_no || '—'} – ${a.appliance || 'Item'}`));
    }
    children.push(new Paragraph({ spacing: { before: 80 }, children: [
      new TextRun({ text: '(Unfound items should be located, inspected, and tagged before next use.)', italics: true, size: 20, color: BRAND_GRAY }),
    ] }));
  }

  children.push(heading('Compliance Statement'));
  children.push(new Paragraph({ children: [
    new TextRun({ text: complianceStatement({ total, passedAssets, failedAssets, unfoundAssets, passedDueDates }), size: 22 }),
  ] }));

  children.push(new Paragraph({ children: [new PageBreak()] }));
  return children;
}

function cell(text, alignment, color) {
  return new TableCell({
    margins: { top: 60, bottom: 60, left: 80, right: 80 },
    children: [new Paragraph({
      alignment: alignment || AlignmentType.LEFT,
      children: [new TextRun({ text: String(text), size: 18, color, bold: !!color })],
    })],
  });
}

function buildRegisterTable({ assets, testByAssetId }) {
  const headerRow = new TableRow({
    tableHeader: true,
    children: ['Plant No.', 'Plant Description', 'Tag No.', 'Pass/Fail', 'Test Date', 'Next Due'].map((h) => new TableCell({
      shading: { fill: BRAND_ORANGE, type: ShadingType.CLEAR, color: 'auto' },
      verticalAlign: VerticalAlign.CENTER,
      margins: { top: 60, bottom: 60, left: 80, right: 80 },
      children: [new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: h, bold: true, color: 'FFFFFF', size: 20 })],
      })],
    })),
  });

  const rows = [headerRow];
  for (const a of assets) {
    const t = testByAssetId[a.id];
    const resultText = t ? (t.result === 'fail' ? 'Fail' : 'Pass') : 'Unfound';
    const testDateText = t ? formatDMY(t.test_date) : 'N/A';
    const nextDueText = t && t.result === 'pass' ? formatDMY(t.next_due) : 'N/A';
    const resultColor = t ? (t.result === 'fail' ? FAIL_RED : undefined) : UNFOUND_GRAY;
    const tagText = t && t.tag_no ? t.tag_no : '—';
    rows.push(new TableRow({ children: [
      cell(a.plant_no || '—', AlignmentType.CENTER),
      cell(a.appliance || '—'),
      cell(tagText, AlignmentType.CENTER),
      cell(resultText, AlignmentType.CENTER, resultColor),
      cell(testDateText, AlignmentType.CENTER),
      cell(nextDueText, AlignmentType.CENTER),
    ] }));
  }
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows });
}

// site: used when scoping by Site (the original, default behaviour). jobNumber: when given,
// the report is scoped by Job Number instead (site is ignored for narrative/heading purposes,
// even if also present on individual asset rows -- a job can span multiple sites/vehicles).
// clientName: optional, surfaced under the cover title and in the details page when given.
async function buildReportDocx({ site, jobNumber, clientName, testDate, assets, testByAssetId }) {
  const scopeType = jobNumber ? 'job_number' : 'site';
  const scopeValue = jobNumber || site;
  const doc = new Document({
    sections: [{
      properties: { page: { margin: { top: 720, bottom: 900, left: 900, right: 900 } } },
      footers: { default: footer() },
      children: [
        ...buildCoverPage({ testDate, scopeType, scopeValue, clientName }),
        ...buildDetailsPage({ testDate, assets, testByAssetId, scopeType, scopeValue, clientName }),
        heading('Register'),
        buildRegisterTable({ assets, testByAssetId }),
      ],
    }],
  });
  return Packer.toBuffer(doc);
}

module.exports = { buildReportDocx, formatDMY, formatLong };
