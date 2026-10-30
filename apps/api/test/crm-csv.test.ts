import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/modules/crm/csv.js';
describe('bounded CSV parsing', () => {
  it('supports BOM, quoted commas and multiline content without executing formula text', () => {
    const result = parseCsv(
      '\uFEFFdisplayName,title,description\r\n"Synthetic, Person",Prospect,"=SUM(A1)\nsecond line"',
    );
    expect(result.rows[0]?.intake?.lead.description).toBe('=SUM(A1)\nsecond line');
    expect(result.rows[0]?.intake?.contact.mode).toBe('create');
  });
  it.each([
    'displayName,displayName,title\nA,A,T',
    '__proto__,title\nA,T',
    'constructor,title\nA,T',
    'displayName;title\nA;T',
    'displayName,title\n"unterminated,T',
    'displayName,title\nA,T,extra',
    'displayName,unknown,title\nA,B,T',
  ])('rejects malformed headers or records: %s', (csv) => expect(() => parseCsv(csv)).toThrow());
  it('requires distinct explicit supported mappings for aliases', () => {
    expect(() => parseCsv('toString,title\nSynthetic,Title', {})).toThrow();
    expect(
      parseCsv('Name,Opportunity\nSynthetic,Title', { Name: 'displayName', Opportunity: 'title' })
        .rows[0]?.errorCode,
    ).toBeNull();
    expect(() =>
      parseCsv('Name,Opportunity\nSynthetic,Title', { Name: 'title', Opportunity: 'title' }),
    ).toThrow();
  });
  it('enforces row, byte, field and encoding bounds', () => {
    for (const csv of [
      'displayName,title\n' + 'A,T\n'.repeat(101),
      'displayName,title\nA,' + 'x'.repeat(4097),
      'displayName,title\nA,\uFFFD',
      'displayName,title\nA,\0',
      'displayName,title\nA,' + 'é'.repeat(140000),
    ])
      expect(() => parseCsv(csv)).toThrow();
  });
  it('keeps invalid rows as safe validation results instead of accepting partial fields', () => {
    const result = parseCsv(
      'displayName,title,email,phone,phoneRegion\nSynthetic,Title,invalid,,\nOther,Title,,123,US',
    );
    expect(result.rows.map((v) => v.intake)).toEqual([null, null]);
    expect(result.rows[0]?.fields).toContain('contact.data.emails.0');
  });
});
