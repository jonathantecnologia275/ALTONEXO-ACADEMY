// api/generate-certificate.js
// Generates an official-looking PDF certificate (with QR code + security code)
// when an Admin marks a student's enrollment as completed.
// Only works for accounts marked is_admin = true in Supabase.

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import QRCode from 'qrcode';
import crypto from 'crypto';

const SUPABASE_URL = 'https://qmpoxscqjgtnlipadnmq.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_AbWohQb6y4oozbcH-t4nyw_PrDW8n4G';

function randomSecurityCode() {
  return crypto.randomBytes(5).toString('hex').toUpperCase().slice(0, 8);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { access_token, enrollment_id } = req.body || {};
  if (!access_token || !enrollment_id) {
    return res.status(400).json({ error: 'Missing access_token or enrollment_id' });
  }

  try {
    // 1. Verify the token belongs to a real, logged-in Supabase user
    const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${access_token}`, apikey: SUPABASE_ANON_KEY },
    });
    if (!userResp.ok) return res.status(401).json({ error: 'Invalid session' });
    const user = await userResp.json();

    // 2. Verify this user is an admin
    const profileResp = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=is_admin`,
      { headers: { Authorization: `Bearer ${access_token}`, apikey: SUPABASE_ANON_KEY } }
    );
    const profileData = await profileResp.json();
    const isAdmin = Array.isArray(profileData) && profileData[0]?.is_admin === true;
    if (!isAdmin) return res.status(403).json({ error: 'Not authorized' });

    // 3. Fetch the enrollment + student + class
    const enrollResp = await fetch(
      `${SUPABASE_URL}/rest/v1/enrollments?id=eq.${enrollment_id}&select=*,students(*),classes(*)`,
      { headers: { Authorization: `Bearer ${access_token}`, apikey: SUPABASE_ANON_KEY } }
    );
    const enrollRows = await enrollResp.json();
    const enrollment = Array.isArray(enrollRows) ? enrollRows[0] : null;
    if (!enrollment) return res.status(404).json({ error: 'Enrollment not found' });

    const student = enrollment.students;
    const klass = enrollment.classes;
    if (!student || !klass) return res.status(400).json({ error: 'Missing student or class data' });

    // 4. Generate certificate code (ALTONEXO-2026-00001) by counting existing certs this year
    const year = new Date().getFullYear();
    const countResp = await fetch(
      `${SUPABASE_URL}/rest/v1/certificates?certificate_code=like.ALTONEXO-${year}-*&select=id`,
      { headers: { Authorization: `Bearer ${access_token}`, apikey: SUPABASE_ANON_KEY, Prefer: 'count=exact' } }
    );
    const existingCerts = await countResp.json();
    const seq = String((Array.isArray(existingCerts) ? existingCerts.length : 0) + 1).padStart(5, '0');
    const certificateCode = `ALTONEXO-${year}-${seq}`;
    const securityCode = randomSecurityCode();
    const completionDate = new Date().toISOString().slice(0, 10);

    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const verificationUrl = `${protocol}://${host}/verificar-certificado.html?code=${certificateCode}`;

    // 5. Generate QR code as PNG buffer
    const qrPngDataUrl = await QRCode.toDataURL(verificationUrl, { margin: 1, width: 260 });
    const qrPngBytes = Buffer.from(qrPngDataUrl.split(',')[1], 'base64');

    // 6. Try to fetch the academy logo (falls back silently if unavailable)
    let logoBytes = null;
    try {
      const logoResp = await fetch(`${protocol}://${host}/assets/logo.png`);
      if (logoResp.ok) logoBytes = Buffer.from(await logoResp.arrayBuffer());
    } catch (_) { /* ignore, logo is optional */ }

    // 7. Build the PDF (landscape, elegant border, bilingual wording)
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([842, 595]); // A4 landscape
    const { width, height } = page.getSize();

    const navy = rgb(0.043, 0.059, 0.180);
    const gold = rgb(0.890, 0.655, 0.235);
    const ink = rgb(0.043, 0.059, 0.180);
    const inkSoft = rgb(0.357, 0.380, 0.470);

    const fontRegular = await pdfDoc.embedFont(StandardFonts.TimesRoman);
    const fontBold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
    const fontItalic = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);
    const fontMono = await pdfDoc.embedFont(StandardFonts.Courier);

    // Background
    page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(0.996, 0.988, 0.965) });

    // Outer border (gold) + inner border (navy)
    page.drawRectangle({ x: 18, y: 18, width: width - 36, height: height - 36, borderColor: gold, borderWidth: 3 });
    page.drawRectangle({ x: 30, y: 30, width: width - 60, height: height - 60, borderColor: navy, borderWidth: 1 });

    const centerX = width / 2;

    // Logo (if available)
    if (logoBytes) {
      try {
        const logoImage = await pdfDoc.embedPng(logoBytes);
        const logoDims = logoImage.scale(48 / logoImage.height);
        page.drawImage(logoImage, { x: centerX - logoDims.width / 2, y: height - 100, width: logoDims.width, height: logoDims.height });
      } catch (_) { /* ignore malformed logo */ }
    }

    const drawCentered = (text, y, font, size, color) => {
      const w = font.widthOfTextAtSize(text, size);
      page.drawText(text, { x: centerX - w / 2, y, size, font, color });
    };

    drawCentered('ALTONEXO ACADEMY', height - 130, fontBold, 15, navy);
    drawCentered('Punta Cana, República Dominicana', height - 148, fontRegular, 9, inkSoft);

    drawCentered('CERTIFICADO DE FINALIZACIÓN', height - 195, fontBold, 26, navy);
    drawCentered('CERTIFICATE OF COMPLETION', height - 218, fontItalic, 13, gold);

    drawCentered('Se certifica que  •  This certifies that', height - 260, fontRegular, 11, inkSoft);

    drawCentered(student.full_name.toUpperCase(), height - 300, fontBold, 27, ink);
    // underline
    const nameWidth = fontBold.widthOfTextAtSize(student.full_name.toUpperCase(), 27);
    page.drawLine({ start: { x: centerX - nameWidth / 2 - 10, y: height - 308 }, end: { x: centerX + nameWidth / 2 + 10, y: height - 308 }, thickness: 1, color: gold });

    drawCentered('ha completado satisfactoriamente el programa  •  has successfully completed the program', height - 335, fontRegular, 11, inkSoft);
    drawCentered(klass.name, height - 365, fontBold, 19, navy);

    drawCentered(`Fecha de finalización / Completion date: ${new Date(completionDate + 'T00:00:00').toLocaleDateString('es-DO', { day: '2-digit', month: 'long', year: 'numeric' })}`, height - 400, fontRegular, 10.5, inkSoft);

    // Signature area (left)
    const sigY = 110;
    page.drawLine({ start: { x: 110, y: sigY + 26 }, end: { x: 330, y: sigY + 26 }, thickness: 1, color: inkSoft });
    page.drawText('Director Académico', { x: 150, y: sigY + 10, size: 10.5, font: fontBold, color: navy });
    page.drawText('ALTONEXO ACADEMY', { x: 150, y: sigY - 4, size: 8.5, font: fontRegular, color: inkSoft });
    page.drawText('Jonathan Grolot', { x: 150, y: sigY + 32, size: 15, font: fontItalic, color: navy });

    // Seal (drawn, right of signature)
    const sealCenter = { x: 480, y: sigY + 18 };
    const sealRadius = 42;
    page.drawEllipse({ x: sealCenter.x, y: sealCenter.y, xScale: sealRadius, yScale: sealRadius, borderColor: gold, borderWidth: 2.5, color: rgb(0.996, 0.988, 0.965) });
    page.drawEllipse({ x: sealCenter.x, y: sealCenter.y, xScale: sealRadius - 7, yScale: sealRadius - 7, borderColor: navy, borderWidth: 1 });
    drawSealText(page, 'ALTONEXO ACADEMY', sealCenter.x, sealCenter.y + 14, fontBold, 6.5, navy);
    drawSealText(page, 'SELLO OFICIAL', sealCenter.x, sealCenter.y + 2, fontBold, 7.5, gold);
    drawSealText(page, 'REPÚBLICA DOMINICANA', sealCenter.x, sealCenter.y - 10, fontRegular, 5.5, navy);
    drawSealText(page, '★', sealCenter.x, sealCenter.y - 24, fontBold, 9, gold);

    function drawSealText(pg, text, cx, y, font, size, color) {
      const w = font.widthOfTextAtSize(text, size);
      pg.drawText(text, { x: cx - w / 2, y, size, font, color });
    }

    // QR code (right side)
    const qrImage = await pdfDoc.embedPng(qrPngBytes);
    const qrSize = 92;
    page.drawImage(qrImage, { x: width - 150, y: 90, width: qrSize, height: qrSize });
    page.drawText('Verificar autenticidad', { x: width - 158, y: 78, size: 7.5, font: fontRegular, color: inkSoft });
    page.drawText('Scan to verify', { x: width - 138, y: 68, size: 7, font: fontItalic, color: inkSoft });

    // Codes footer
    page.drawText(`Código de certificado: ${certificateCode}`, { x: 40, y: 46, size: 9, font: fontMono, color: navy });
    page.drawText(`Código de seguridad: ${securityCode}`, { x: 40, y: 32, size: 9, font: fontMono, color: navy });

    const pdfBytes = await pdfDoc.save();

    // 8. Upload PDF to Cloudflare R2 (reusing the same credentials as video uploads)
    const s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
    const objectKey = `certificates/${certificateCode}.pdf`;
    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: objectKey,
      Body: pdfBytes,
      ContentType: 'application/pdf',
    }));
    const certificateUrl = `${process.env.R2_PUBLIC_URL}/${objectKey}`;

    // 9. Insert certificate record
    const insertResp = await fetch(`${SUPABASE_URL}/rest/v1/certificates`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access_token}`,
        apikey: SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        student_id: student.id,
        enrollment_id: enrollment.id,
        certificate_code: certificateCode,
        security_code: securityCode,
        student_full_name: student.full_name,
        class_name: klass.name,
        completion_date: completionDate,
        certificate_url: certificateUrl,
        verification_url: verificationUrl,
        is_valid: true,
      }),
    });
    if (!insertResp.ok) {
      const errText = await insertResp.text();
      throw new Error('No se pudo guardar el certificado: ' + errText);
    }

    // 10. Mark the enrollment as completed
    await fetch(`${SUPABASE_URL}/rest/v1/enrollments?id=eq.${enrollment.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${access_token}`,
        apikey: SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status: 'completado', completed_at: new Date().toISOString() }),
    });

    return res.status(200).json({ certificateUrl, certificateCode, securityCode });
  } catch (err) {
    console.error('generate-certificate error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}