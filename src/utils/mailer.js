const nodemailer = require("nodemailer");

// Read at call-time so a server restart after editing .env picks up changes.
function smtpConfig() {
  return {
    host: process.env.SMTP_HOST || "smtp.ionos.co.uk",
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER || "noreply@spotmatch.fostorial.co.uk",
    pass: process.env.SMTP_PASS || ""
  };
}

function createTransporter(cfg) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: {
      user: cfg.user,
      pass: cfg.pass
    }
  });
}

// Called once at startup so the operator can see immediately whether email is live.
function logSmtpStatus() {
  const cfg = smtpConfig();
  if (cfg.pass) {
    // eslint-disable-next-line no-console
    console.log(`[SMTP] Configured — sending via ${cfg.user} on ${cfg.host}:${cfg.port}`);
  } else {
    // eslint-disable-next-line no-console
    console.log("[SMTP] No SMTP_PASS set — password reset links will be printed to the console instead of emailed.");
  }
}

async function sendPasswordResetEmail(toEmail, resetUrl) {
  const cfg = smtpConfig();

  if (!cfg.pass) {
    // No credentials — log so the developer can still test the flow.
    // eslint-disable-next-line no-console
    console.log(`[SMTP DEV] Password reset link for ${toEmail}:\n  ${resetUrl}`);
    return;
  }

  const transporter = createTransporter(cfg);
  const from = `Dobble Generator <${cfg.user}>`;

  await transporter.sendMail({
    from,
    to: toEmail,
    subject: "Reset your password",
    text: [
      "You requested a password reset for your Dobble Generator account.",
      "",
      "Click the link below to set a new password. The link expires in 1 hour.",
      "",
      resetUrl,
      "",
      "If you did not request this you can safely ignore this email."
    ].join("\n"),
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a2e">
        <h2 style="color:#6f3cff">Reset your password</h2>
        <p>You requested a password reset for your Dobble Generator account.</p>
        <p>Click the button below to choose a new password. This link expires in&nbsp;<strong>1&nbsp;hour</strong>.</p>
        <p style="margin:2rem 0">
          <a href="${resetUrl}"
             style="display:inline-block;padding:12px 28px;background:#6f3cff;color:#fff;
                    text-decoration:none;border-radius:8px;font-weight:700;font-size:1rem">
            Reset password
          </a>
        </p>
        <p style="font-size:0.85rem;color:#666">
          Or copy this link into your browser:<br>
          <a href="${resetUrl}" style="color:#6f3cff;word-break:break-all">${resetUrl}</a>
        </p>
        <hr style="border:none;border-top:1px solid #eee;margin:2rem 0">
        <p style="font-size:0.8rem;color:#999">
          If you did not request this you can safely ignore this email.
        </p>
      </div>
    `
  });
}

module.exports = { logSmtpStatus, sendPasswordResetEmail };
