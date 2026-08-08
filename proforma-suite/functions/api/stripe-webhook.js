async function verifyStripeSignature(payload, sigHeader, secret) {
    if (!sigHeader || !secret) return false;

    const parts = sigHeader.split(",");
    let timestamp = "";
    let signature = "";

    for (const part of parts) {
        if (part.startsWith("t=")) timestamp = part.slice(2);
        if (part.startsWith("v1=")) signature = part.slice(3);
    }

    if (!timestamp || !signature) return false;

    const signedPayload = `${timestamp}.${payload}`;
    const encoder = new TextEncoder();

    const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );

    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(signedPayload));
    const expectedSig = Array.from(new Uint8Array(sig))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");

    const tolerance = 300;
    const diff = Math.abs(Math.floor(Date.now() / 1000) - parseInt(timestamp));
    if (diff > tolerance) return false;

    return expectedSig === signature;
}

function generateLicenseKey() {
    const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let key = "";
    for (let i = 0; i < 25; i++) {
        key += charset.charAt(Math.floor(Math.random() * charset.length));
        if ((i + 1) % 5 === 0 && i !== 24) key += "-";
    }
    return key;
}

function generateExpirationDate() {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    return d.toISOString().split("T")[0];
}

function extractEmail(event) {
    const obj = event.data?.object || event.data || {};
    return (
        obj.customer_details?.email ||
        obj.receipt_email ||
        obj.billing_details?.email ||
        obj.customer_email ||
        "unknown"
    );
}

function isPaymentSuccess(type) {
    return (
        type === "checkout.session.completed" ||
        type === "payment_intent.succeeded" ||
        type === "invoice.paid"
    );
}

export async function onRequestPost(context) {
    const headers = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
    };

    const rawBody = await context.request.text();
    const sigHeader = context.request.headers.get("stripe-signature");

    const isValid = await verifyStripeSignature(
        rawBody,
        sigHeader,
        context.env.STRIPE_WEBHOOK_SECRET
    );

    if (!isValid) {
        return new Response("Webhook signature verification failed.", { status: 400, headers });
    }

    let stripeEvent;
    try {
        stripeEvent = JSON.parse(rawBody);
    } catch (err) {
        return new Response("Invalid JSON", { status: 400, headers });
    }

    if (isPaymentSuccess(stripeEvent.type)) {
        const customerEmail = extractEmail(stripeEvent);
        const licenseKey = generateLicenseKey();
        const expires = generateExpirationDate();

        // Store in Upstash
        try {
            await fetch(
                `${context.env.UPSTASH_REDIS_REST_URL}/set/${licenseKey}`,
                {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${context.env.UPSTASH_REDIS_REST_TOKEN}`,
                        "Content-Type": "application/json"
                    },
                    body: "valid"
                }
            );
        } catch (err) {
            console.error("Upstash error:", err.message);
        }

        // Send email via Resend
        try {
            if (context.env.RESEND_API_KEY && customerEmail !== "unknown") {
                await fetch("https://api.resend.com/emails", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${context.env.RESEND_API_KEY}`
                    },
                    body: JSON.stringify({
                        from: "ProForma Suite <noreply@proforma-suite.com>",
                        to: customerEmail,
                        subject: "Your License Key",
                        html: `
                            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
                                <h2 style="color:#333;">Thank you for your purchase!</h2>
                                <p style="color:#555;">Your license key is:</p>
                                <pre style="font-size:20px;letter-spacing:3px;background:#f5f5f5;padding:16px;border-radius:6px;text-align:center;">${licenseKey}</pre>
                                <p style="color:#555;"><strong>Valid until:</strong> ${expires}</p>
                                <p style="color:#555;">Enter your key here to unlock your download:</p>
                                <p style="text-align:center;">
                                    <a href="https://proforma-suite.com/downloads.html"
                                       style="background:#0066cc;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">
                                        Go to Download Portal
                                    </a>
                                </p>
                                <p style="color:#555;">Or visit: <a href="https://proforma-suite.com/downloads.html">https://proforma-suite.com/downloads.html</a></p>
                                <hr style="border:none;border-top:1px solid #eee;margin:20px 0;">
                                <p style="color:#999;font-size:12px;">If you have any issues, email us at support@proforma-suite.com</p>
                            </div>
                        `
                    })
                });
            }
        } catch (err) {
            console.error("Resend error:", err.message);
        }

        return new Response(JSON.stringify({ status: "success", licenseKey, expires, email: customerEmail }), { status: 200, headers });
    }

    return new Response(JSON.stringify({ status: "ignored", type: stripeEvent.type }), { status: 200, headers });
}
