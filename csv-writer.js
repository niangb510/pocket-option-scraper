const fs = require('fs');

class CsvWriter {
  constructor(filePath, headers) {
    this.filePath = filePath;
    this.headers = headers;
    this.rowCount = 0;
    this.isClosed = false;
    const fileExists = fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
    this.writeStream = fs.createWriteStream(filePath, { flags: 'a' });
    if (!fileExists) {
      this.writeStream.write(headers.join(',') + '\n');
    }
    console.log('CSV ready: ' + filePath);
  }

  writeRow(rowObj) {
    if (this.isClosed) return;
    const values = this.headers.map(h => {
      const val = rowObj[h];
      if (val === null || val === undefined) return '';
      const str = String(val).replace(/"/g, '""');
      if (str.includes(',') || str.includes('\n') || str.includes('"')) {
        return '"' + str + '"';
      }
      return str;
    });
    this.writeStream.write(values.join(',') + '\n');
    this.rowCount++;
  }

  close() {
    if (this.isClosed) return;
    this.isClosed = true;
    this.writeStream.end();
    console.log('CSV closed: ' + this.filePath + ' (' + this.rowCount + ' rows)');
  }
}

module.exports = CsvWriter;
