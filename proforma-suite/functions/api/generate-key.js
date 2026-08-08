function generateLicenseKey() {
    const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let key = "";
    for (let i = 0; i < 25; i++) {
        key += charset.charAt(Math.floor(Math.random() * charset.length));
        if ((i + 1) % 5 === 0 && i !== 24) key += "-";
    }
    return key;
}

export async function onRequestGet() {
    const licenseKey = generateLicenseKey();
    const d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    const expires = d.toISOString().split("T")[0];

    return new Response(JSON.stringify({ status: "success", licenseKey, expires }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
    });
}
