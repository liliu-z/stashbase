import fs from 'node:fs';
import path from 'node:path';
import type { AppFixture } from '../support/fixtures.ts';

export const JOURNEY_MARKDOWN = 'Journey Markdown.md';
export const JOURNEY_JSON = 'raw-data.json';
export const JOURNEY_CSV = 'table-data.csv';
export const CROSS_FOLDER_NOTE = 'Cross Folder Result.md';
export const EXACT_SEARCH_PHRASE = 'orchid regression phrase 7319';
export const JOURNEY_HTML = 'read-only.html';
export const JOURNEY_AUDIO = 'silence.wav';
export const MALFORMED_PDF = 'broken.pdf';
export const MALFORMED_DOCX = 'broken.docx';
export const JOURNEY_PDF = 'two-pages.pdf';
export const JOURNEY_DOCX = 'valid-document.docx';
export const LEGACY_DERIVED_NOTE = '.two-pages.pdf.md';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

// Minimal reviewed OOXML package containing one paragraph. Keeping the
// deterministic binary inline avoids platform zip-tool differences in CI.
const VALID_DOCX = Buffer.from(
  'UEsDBAoAAAAIALxUDF15bjPX6AAAAK0BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH1QyU7DMBD9FWuuKHHggBCK0wPLETiUDxjZk8SqN3nc0v49Tlt6QIXjzFv1+tXeO7GjzDYGBbdtB4KCjsaGScHn+rV5AMEFg0EXAyk4EMNq6NeHRCyqNrCCuZT0KCXrmTxyGxOFiowxeyz1zJNMqDc4kbzrunupYygUSlMWDxj6Zxpx64p42df3qUcmxyCeTsQlSwGm5KzGUnG5C+ZXSnNOaKvyyOHZJr6pBJBXExbk74Cz7r0Ok60h8YG5vKGvLPkVs5Em6q2vyvZ/mys94zhaTRf94pZy1MRcF/euvSAebfjpL49zD99QSwMECgAAAAAAvFQMXQAAAAAAAAAAAAAAAAYAAABfcmVscy9QSwMECgAAAAgAvFQMXZv9N+qtAAAAKQEAAAsAAABfcmVscy8ucmVsc43POw7CMAwG4KtE3mlaBoRQ0y4IqSsqB7ASN61oHkrCo7cnAwNFDIy2f3+W6/ZpZnanECdnBVRFCYysdGqyWsClP232wGJCq3B2lgQsFKFt6jPNmPJKHCcfWTZsFDCm5A+cRzmSwVg4TzZPBhcMplwGzT3KK2ri27Lc8fBpwNpknRIQOlUB6xdP/9huGCZJRydvhmz6ceIrkWUMmpKAhwuKq3e7yCzwpuarF5sXUEsDBAoAAAAAALxUDF0AAAAAAAAAAAAAAAAFAAAAd29yZC9QSwMECgAAAAgAvFQMXRR1VTuxAAAA7gAAABEAAAB3b3JkL2RvY3VtZW50LnhtbEWOMQ7CMAxFrxJlhxQGhKq2DCBWGACxhsRAUWNXdkrp7WnKwPIs/y8/udh8QqPewFITlnoxz7QCdORrfJT6fNrP1lpJtOhtQwilHkD0pir63JPrAmBUowAl70v9jLHNjRH3hGBlTi3g2N2Jg43jyg/TE/uWyYHI6A+NWWbZygRbo07KG/khzTaBE2J1sU3t1e6wvaoXdYwwKOn4bh0UJvWJPHG6EnDxyGYKfjrzf7X6AlBLAQIUAAoAAAAIALxUDF15bjPX6AAAAK0BAAATAAAAAAAAAAAAAAAAAAAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQACgAAAAAAvFQMXQAAAAAAAAAAAAAAAAYAAAAAAAAAAAAQAAAAGQEAAF9yZWxzL1BLAQIUAAoAAAAIALxUDF2b/TfqrQAAACkBAAALAAAAAAAAAAAAAAAAAD0BAABfcmVscy8ucmVsc1BLAQIUAAoAAAAAALxUDF0AAAAAAAAAAAAAAAAFAAAAAAAAAAAAEAAAABMCAAB3b3JkL1BLAQIUAAoAAAAIALxUDF0UdVU7sQAAAO4AAAARAAAAAAAAAAAAAAAAADYCAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAABQAFACABAAAWAwAAAAA=',
  'base64',
);

function write(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function silentWav(): Buffer {
  const sampleRate = 8_000;
  const samples = 800;
  const dataBytes = samples * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

function twoPagePdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 6 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
  ];
  let source = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(source, 'ascii'));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(source, 'ascii');
  source += `xref\n0 ${objects.length + 1}\n`;
  source += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) source += `${String(offset).padStart(10, '0')} 00000 n \n`;
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source, 'ascii');
}

export function seedJourneyWorkspaces(fixture: AppFixture): void {
  const { projectA, projectB } = fixture.workspaces;
  write(path.join(projectA, 'pixel.png'), ONE_PIXEL_PNG);
  write(path.join(projectA, JOURNEY_HTML), '<!doctype html><title>Read-only fixture</title><h1>HTML journey surface</h1>');
  write(path.join(projectA, JOURNEY_AUDIO), silentWav());
  write(path.join(projectA, MALFORMED_PDF), '%PDF-this-is-not-a-document\n');
  write(path.join(projectA, MALFORMED_DOCX), 'not a zip-backed office document');
  write(path.join(projectA, JOURNEY_PDF), twoPagePdf());
  write(path.join(projectA, JOURNEY_DOCX), VALID_DOCX);
  write(path.join(projectA, LEGACY_DERIVED_NOTE), '# Hidden derived regression phrase\n');
  write(path.join(projectB, 'beta-pixel.png'), ONE_PIXEL_PNG);
  write(path.join(projectA, JOURNEY_MARKDOWN), [
    '---',
    'title: Journey fixture',
    'tags:',
    '  - regression',
    '---',
    '# Journey Markdown',
    '',
    `Alpha contains the ${EXACT_SEARCH_PHRASE}.`,
    '',
    '[Open Second Note](./Second%20Note.md)',
    '',
    '[Open external fixture](https://example.com/stashbase-e2e)',
    '',
    '![Local fixture pixel](./pixel.png)',
    '',
    '![Remote fixture pixel](https://remote.invalid/stashbase-e2e.png)',
    '',
    '## Outline Section',
    '',
    'Outline find phrase appears here.',
    '',
    '### Deep Detail',
    '',
    'Deep outline content.',
    '',
    '| Feature | State |',
    '| --- | --- |',
    '| Table journey | Ready |',
    '',
    '- [x] Completed task journey',
    '',
    '```ts',
    'const regressionJourney = true;',
    '```',
    '',
    '> [!NOTE]',
    '> Alert journey content.',
    '',
    '$$E = mc^2$$',
    '',
  ].join('\n'));
  write(path.join(projectA, JOURNEY_JSON), '{\r\n  "fixture": "raw journey",\r\n  "editable": true\r\n}\r\n');
  write(path.join(projectA, JOURNEY_CSV), '\uFEFFid,name,role\r\n101,Alice,engineer\r\n102,Bob,designer\r\n');
  write(path.join(projectB, CROSS_FOLDER_NOTE), [
    '# Cross Folder Result',
    '',
    `Beta also contains the ${EXACT_SEARCH_PHRASE}.`,
    '',
    '[Beta sibling](./Notes.md)',
    '',
    '![Beta fixture pixel](./beta-pixel.png)',
    '',
  ].join('\n'));
}
