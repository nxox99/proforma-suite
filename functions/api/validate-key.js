function isValidFormat(key) {
    const pattern = /^[A-Z0-9]{5}(-[A-Z0-9]{5}){4}$/;
    return pattern.test(key);
}

export async function onRequestPost(context) {
    const headers = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
    };

    let body;
    try {
        body = await context.request.json();
    } catch {
        return new Response(JSON.stringify({ status: "error", message: "Invalid request." }), { status: 400, headers });
    }

    const licenseKey = (body.licenseKey || "").trim().toUpperCase();

    if (!licenseKey) {
        return new Response(JSON.stringify({ status: "error", message: "Missing license key." }), { status: 400, headers });
    }

    if (!isValidFormat(licenseKey)) {
        return new Response(JSON.stringify({
            status: "invalid",
            message: "License key format is invalid. Expected: XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
        }), { status: 200, headers });
    }

    try {
        const response = await fetch(
            `${context.env.UPSTASH_REDIS_REST_URL}/get/${licenseKey}`,
            { headers: { Authorization: `Bearer ${context.env.UPSTASH_REDIS_REST_TOKEN}` } }
        );

        const data = await response.json();
        const result = data.result;

        if (!result) {
            return new Response(JSON.stringify({ status: "invalid", message: "License key not found." }), { status: 200, headers });
        }

        if (result === "valid") {
            return new Response(JSON.stringify({ status: "valid", message: "License key is valid." }), { status: 200, headers });
        }

        try {
            const record = JSON.parse(result);
            if (record.expires && new Date(record.expires) < new Date()) {
                return new Response(JSON.stringify({ status: "expired", message: "This license key has expired." }), { status: 200, headers });
            }
            return new Response(JSON.stringify({ status: "valid", message: "License key is valid." }), { status: 200, headers });
        } catch {
            return new Response(JSON.stringify({ status: "valid", message: "License key is valid." }), { status: 200, headers });
        }

    } catch (err) {
        return new Response(JSON.stringify({ status: "error", message: "Could not verify license key: " + err.message }), { status: 200, headers });
    }
}

export async function onRequestOptions() {
    return new Response(null, {
        status: 204,
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type"
        }
    });
}
