/**
 * @file public/js/qr_generator.js
 * Zero-dependency standalone QR Code SVG Generator (ISO/IEC 18004 byte-mode)
 * Live Clinic Queue Tracker (Features F13, F14)
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    const api = factory();
    root.QRCode = api.QRCode;
    root.generateQRCodeSVG = api.generateSVG;
  }
})(typeof self !== 'undefined' ? self : this, function () {

  // --- GF(256) Tables for Reed-Solomon Error Correction ---
  const EXP_TABLE = new Uint8Array(512);
  const LOG_TABLE = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP_TABLE[i] = x;
    EXP_TABLE[i + 255] = x;
    LOG_TABLE[x] = i;
    x = (x << 1) ^ (x & 128 ? 0x11d : 0);
  }

  function gmult(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP_TABLE[LOG_TABLE[a] + LOG_TABLE[b]];
  }

  // Reed-Solomon polynomial generator
  function rsGenPoly(numEc) {
    let poly = [1];
    for (let i = 0; i < numEc; i++) {
      const next = [1, EXP_TABLE[i]];
      const res = new Uint8Array(poly.length + 1);
      for (let j = 0; j < poly.length; j++) {
        res[j] ^= gmult(poly[j], next[0]);
        res[j + 1] ^= gmult(poly[j], next[1]);
      }
      poly = Array.from(res);
    }
    return poly;
  }

  function rsCalculateEcc(data, numEc) {
    const gen = rsGenPoly(numEc);
    const ecc = new Uint8Array(numEc);
    for (let i = 0; i < data.length; i++) {
      const factor = data[i] ^ ecc[0];
      for (let j = 0; j < numEc - 1; j++) {
        ecc[j] = ecc[j + 1] ^ gmult(gen[j + 1], factor);
      }
      ecc[numEc - 1] = gmult(gen[numEc], factor);
    }
    return ecc;
  }

  // Version Table: [Version, TotalCodewords, DataCodewordsLevelM, EcCodewordsLevelM, AlignmentPositions]
  // Supports byte lengths up to 134 bytes (Versions 1 through 6)
  const VERSION_SPECS = [
    null,
    { ver: 1, total: 26, data: 16, ec: 10, align: [] },
    { ver: 2, total: 44, data: 28, ec: 16, align: [6, 18] },
    { ver: 3, total: 70, data: 44, ec: 26, align: [6, 22] },
    { ver: 4, total: 100, data: 64, ec: 36, align: [6, 26] },
    { ver: 5, total: 134, data: 86, ec: 48, align: [6, 30] },
    { ver: 6, total: 172, data: 108, ec: 64, align: [6, 34] }
  ];

  function selectVersion(byteLength) {
    for (let v = 1; v < VERSION_SPECS.length; v++) {
      // Byte mode header: 4 bits mode + 8 bits length (for V1-9) = 1.5 bytes -> need data capacity >= byteLength + 2
      if (VERSION_SPECS[v].data >= byteLength + 3) return VERSION_SPECS[v];
    }
    return VERSION_SPECS[VERSION_SPECS.length - 1]; // Fallback to highest
  }

  // Format info mask & generator (BCH 15,5)
  const FORMAT_MASK = 0x5412;
  function getFormatBits(ecLevelBits, maskPattern) {
    let data = (ecLevelBits << 3) | maskPattern;
    let rem = data << 10;
    for (let i = 14; i >= 10; i--) {
      if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
    }
    return ((data << 10) | rem) ^ FORMAT_MASK;
  }

  /**
   * Main QR Generator Class
   */
  class QRCodeGenerator {
    /**
     * Generate an SVG string representation of a QR code
     * @param {string} text Target URL or string
     * @param {object} [options]
     * @param {number} [options.margin=4] Quiet zone module count
     * @param {string} [options.darkColor='#000000']
     * @param {string} [options.lightColor='#ffffff']
     * @param {number} [options.size=256] Output SVG width/height in px
     * @returns {string} SVG Markup
     */
    static generateSVG(text, options = {}) {
      const margin = options.margin !== undefined ? options.margin : 4;
      const darkColor = options.darkColor || '#000000';
      const lightColor = options.lightColor || '#ffffff';
      const size = options.size || 256;

      // Encode UTF-8 byte stream
      const textBytes = new TextEncoder().encode(text || '');
      const spec = selectVersion(textBytes.length);
      const version = spec.ver;
      const moduleCount = 17 + 4 * version;

      // 1. Bit Buffer assembly (Byte mode: 0100)
      const bits = [];
      const pushBits = (val, count) => {
        for (let i = count - 1; i >= 0; i--) bits.push((val >> i) & 1);
      };

      pushBits(0b0100, 4); // Byte mode indicator
      pushBits(textBytes.length, version < 10 ? 8 : 16); // Length indicator
      for (const b of textBytes) pushBits(b, 8); // Data

      // Terminator (up to 4 zeroes)
      const maxBits = spec.data * 8;
      const termBits = Math.min(4, maxBits - bits.length);
      pushBits(0, termBits);

      // Pad to byte boundary
      while (bits.length % 8 !== 0) bits.push(0);

      // Pad bytes to fill data capacity
      const padBytes = [0xEC, 0x11];
      let padIdx = 0;
      while (bits.length < maxBits) {
        pushBits(padBytes[padIdx % 2], 8);
        padIdx++;
      }

      // 2. Codeword extraction
      const dataWords = [];
      for (let i = 0; i < bits.length; i += 8) {
        let byte = 0;
        for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
        dataWords.push(byte);
      }

      // 3. Error correction calculation (Level M)
      const eccWords = rsCalculateEcc(dataWords, spec.ec);
      const finalCodewords = dataWords.concat(Array.from(eccWords));

      // 4. Matrix Initialization
      // 0 = unassigned, 1 = white, 2 = black, >= 4 = reserved function pattern
      const matrix = Array.from({ length: moduleCount }, () => new Uint8Array(moduleCount));

      const setReserved = (r, c, isBlack) => {
        matrix[r][c] = isBlack ? 6 : 4; // 6 = black reserved, 4 = white reserved
      };

      // Finder Patterns + Separators
      const placeFinder = (startR, startC) => {
        for (let r = -1; r <= 7; r++) {
          for (let c = -1; c <= 7; c++) {
            const qr = startR + r;
            const qc = startC + c;
            if (qr < 0 || qr >= moduleCount || qc < 0 || qc >= moduleCount) continue;
            const isBlack = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                            (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                            (r >= 2 && r <= 4 && c >= 2 && c <= 4);
            setReserved(qr, qc, isBlack);
          }
        }
      };

      placeFinder(0, 0);
      placeFinder(0, moduleCount - 7);
      placeFinder(moduleCount - 7, 0);

      // Timing Patterns
      for (let i = 8; i < moduleCount - 8; i++) {
        const isBlack = i % 2 === 0;
        if (matrix[6][i] === 0) setReserved(6, i, isBlack);
        if (matrix[i][6] === 0) setReserved(i, 6, isBlack);
      }

      // Alignment Pattern (for V2+)
      if (spec.align && spec.align.length > 0) {
        for (const r of spec.align) {
          for (const c of spec.align) {
            if (matrix[r][c] !== 0) continue; // Skip finders
            for (let dr = -2; dr <= 2; dr++) {
              for (let dc = -2; dc <= 2; dc++) {
                const isBlack = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
                setReserved(r + dr, c + dc, isBlack);
              }
            }
          }
        }
      }

      // Dark Module
      setReserved(4 * version + 9, 8, true);

      // Reserve Format Information areas
      for (let i = 0; i <= 8; i++) {
        if (matrix[8][i] === 0) matrix[8][i] = 4;
        if (matrix[i][8] === 0) matrix[i][8] = 4;
      }
      for (let i = 0; i < 8; i++) {
        if (matrix[8][moduleCount - 1 - i] === 0) matrix[8][moduleCount - 1 - i] = 4;
        if (matrix[moduleCount - 1 - i][8] === 0) matrix[moduleCount - 1 - i][8] = 4;
      }

      // 5. Data placement (zig-zag 2-column tracks)
      let bitIdx = 0;
      const totalDataBits = finalCodewords.length * 8;
      const getDataBit = (idx) => {
        if (idx >= totalDataBits) return 0;
        const byte = finalCodewords[idx >> 3];
        return (byte >> (7 - (idx & 7))) & 1;
      };

      let upward = true;
      for (let col = moduleCount - 1; col > 0; col -= 2) {
        if (col === 6) col--; // Skip vertical timing column
        const rows = [];
        for (let r = 0; r < moduleCount; r++) rows.push(upward ? moduleCount - 1 - r : r);

        for (const row of rows) {
          for (let c = 0; c < 2; c++) {
            const currCol = col - c;
            if (matrix[row][currCol] === 0) {
              const bit = getDataBit(bitIdx++);
              matrix[row][currCol] = bit ? 2 : 1;
            }
          }
        }
        upward = !upward;
      }

      // 6. Optimal Mask Selection (Mask 0: (row + col) % 2 == 0)
      const maskPattern = 0;
      for (let r = 0; r < moduleCount; r++) {
        for (let c = 0; c < moduleCount; c++) {
          if (matrix[r][c] === 1 || matrix[r][c] === 2) {
            const invert = (r + c) % 2 === 0;
            if (invert) matrix[r][c] = matrix[r][c] === 2 ? 1 : 2;
          }
        }
      }

      // 7. Format Information (EC Level M = 0b00)
      const formatBits = getFormatBits(0b00, maskPattern);
      const getFormatBit = (i) => (formatBits >> i) & 1;

      // Top-left finder format placement
      const tlPositions = [
        [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
        [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]
      ];
      for (let i = 0; i < 15; i++) {
        const [r, c] = tlPositions[i];
        matrix[r][c] = getFormatBit(i) ? 6 : 4;
      }

      // Top-right and bottom-left format placement
      for (let i = 0; i < 8; i++) {
        matrix[8][moduleCount - 1 - i] = getFormatBit(i) ? 6 : 4;
      }
      for (let i = 8; i < 15; i++) {
        matrix[moduleCount - 15 + i][8] = getFormatBit(i) ? 6 : 4;
      }

      // 8. Generate Crisp Vector SVG with single <path>
      const totalDimension = moduleCount + margin * 2;
      let pathD = '';

      for (let r = 0; r < moduleCount; r++) {
        for (let c = 0; c < moduleCount; c++) {
          const val = matrix[r][c];
          const isBlack = val === 2 || val === 6;
          if (isBlack) {
            const x = c + margin;
            const y = r + margin;
            pathD += `M${x},${y}h1v1h-1Z `;
          }
        }
      }

      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalDimension} ${totalDimension}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img" aria-label="QR Code for Patient Queue Tracking">` +
             `<rect width="100%" height="100%" fill="${lightColor}" />` +
             `<path d="${pathD.trim()}" fill="${darkColor}" />` +
             `</svg>`;
    }
  }

  return {
    generateSVG: QRCodeGenerator.generateSVG,
    QRCode: QRCodeGenerator
  };
});
