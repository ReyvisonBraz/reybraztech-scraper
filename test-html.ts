import * as fs from 'fs';
import * as cheerio from 'cheerio';

const html = fs.readFileSync('output/page_dump.html', 'utf-8');
const $ = cheerio.load(html);

const rows = $('.el-table__body-wrapper table tbody tr, table.el-table__body tbody tr, .ant-table-tbody > tr.ant-table-row');
console.log(`Found ${rows.length} rows`);

const data: any[] = [];
rows.each((i, row) => {
  const cells = $(row).find('td');
  if (cells.length < 5) return;

  const getCellText = (index: number) => {
    return $(cells[index]).text().trim();
  };

  const account = getCellText(2);
  const password = getCellText(3);
  const passHidden = $(cells[3]).find('span[style="display: none;"]').text().trim();

  console.log(`Row ${i}: Account='${account}', Password='${password}', HiddenPass='${passHidden}'`);

  if (account) {
    data.push(account);
  }
});

console.log(`Extracted ${data.length} valid accounts:`, data);
