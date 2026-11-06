// Envio de e-mail por relay SMTP (ex.: smtp.gmail.com com senha de app).
import nodemailer from 'nodemailer';

const FROM = process.env.MAIL_FROM || '';
const PORT = Number(process.env.SMTP_PORT) || 465;
const transport = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: PORT,
      secure: PORT === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 15_000,
      socketTimeout: 30_000,
    })
  : null;

export async function sendMail({ to, subject, text, html }) {
  if (!transport) throw new Error('SMTP_HOST não configurado');
  return transport.sendMail({ from: FROM, to, subject, text, html });
}
