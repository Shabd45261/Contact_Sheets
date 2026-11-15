#!/usr/bin/env python3
"""Build a PDF from a folder of JPEG frames.

Each JPEG becomes one page and is embedded byte-for-byte with the PDF
DCTDecode filter, so a frame set is never decoded into memory. Usage:

    python pdf_frames.py <frames_dir> <out.pdf>

Exits non-zero with a message on stderr when the folder has no frames or a
file is not a usable JPEG.
"""
import glob
import os
import sys

# JPEG start-of-frame markers (baseline, extended, progressive, lossless).
SOF = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
       0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
STANDALONE = {0xD8, 0xD9} | set(range(0xD0, 0xD8))


def jpeg_info(path):
    """Return (bytes, width, height, colorspace) for a JPEG file."""
    size = os.path.getsize(path)
    with open(path, 'rb') as f:
        data = f.read()
    if len(data) < 4 or data[0:2] != b'\xff\xd8':
        raise ValueError('not a JPEG: %s' % path)
    i, n = 2, len(data)
    while i + 9 < n:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker == 0xFF:
            i += 1
            continue
        if marker in STANDALONE:
            i += 2
            continue
        length = (data[i + 2] << 8) | data[i + 3]
        if marker in SOF:
            height = (data[i + 5] << 8) | data[i + 6]
            width = (data[i + 7] << 8) | data[i + 8]
            comps = data[i + 9]
            cs = '/DeviceCMYK' if comps == 4 else '/DeviceGray' if comps == 1 else '/DeviceRGB'
            return data, width, height, cs
        i += 2 + length
    raise ValueError('no SOF marker in %s' % path)


def build_pdf(frames_dir, out_path):
    files = sorted(glob.glob(os.path.join(frames_dir, '*.jpg'))
                   + glob.glob(os.path.join(frames_dir, '*.jpeg')))
    if not files:
        raise ValueError('no frames found in %s' % frames_dir)

    count = len(files)
    page_ids = [3 + 3 * i for i in range(count)]
    img_ids = [4 + 3 * i for i in range(count)]
    cont_ids = [5 + 3 * i for i in range(count)]
    offsets = []

    with open(out_path, 'wb') as out:
        def write(text):
            out.write(text.encode('latin-1') if isinstance(text, str) else text)

        def begin(obj_id):
            offsets.append(out.tell())
            write('%d 0 obj\n' % obj_id)

        write('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')

        begin(1)
        write('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')
        begin(2)
        kids = ' '.join('%d 0 R' % p for p in page_ids)
        write('<< /Type /Pages /Count %d /Kids [%s] >>\nendobj\n' % (count, kids))

        for i, frame in enumerate(files):
            data, width, height, cs = jpeg_info(frame)
            begin(page_ids[i])
            write('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] '
                  '/Resources << /XObject << /Im0 %d 0 R >> /ProcSet [/PDF /ImageC] >> '
                  '/Contents %d 0 R >>\nendobj\n'
                  % (width, height, img_ids[i], cont_ids[i]))
            begin(img_ids[i])
            write('<< /Type /XObject /Subtype /Image /Width %d /Height %d '
                  '/ColorSpace %s /BitsPerComponent 8 /Filter /DCTDecode /Length %d >>\nstream\n'
                  % (width, height, cs, len(data)))
            out.write(data)
            write('\nendstream\nendobj\n')
            content = 'q\n%d 0 0 %d 0 0 cm\n/Im0 Do\nQ\n' % (width, height)
            begin(cont_ids[i])
            write('<< /Length %d >>\nstream\n%s' % (len(content), content))
            write('endstream\nendobj\n')

        xref = out.tell()
        total = 2 + 3 * count
        write('xref\n0 %d\n0000000000 65535 f \n' % (total + 1))
        for off in offsets:
            write('%010d 00000 n \n' % off)
        write('trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n'
               % (total + 1, xref))

    return count


def main(argv):
    if len(argv) != 3:
        sys.stderr.write('usage: pdf_frames.py <frames_dir> <out.pdf>\n')
        return 2
    try:
        pages = build_pdf(argv[1], argv[2])
    except Exception as exc:  # noqa: BLE001 - surface any failure to the caller
        sys.stderr.write('pdf_frames: %s\n' % exc)
        return 1
    sys.stdout.write('pages=%d\n' % pages)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
