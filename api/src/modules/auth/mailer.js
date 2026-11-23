import nodemailer from 'nodemailer';

export function createMailer(config) {
  const transport = nodemailer.createTransport(config.transport);
  return {
    send(to, purpose, link) {
      const verify = purpose === 'verify';
      return transport.sendMail({
        from: config.from,
        to,
        subject: verify ? 'Verify your BenefitBridge email' : 'Reset your BenefitBridge password',
        text: (verify ? 'Verify your email using this link:' : 'Reset your password using this link:') +
          '\n\n' + link + '\n\nIf you did not request this, you can ignore this email.',
      });
    },
  };
}
