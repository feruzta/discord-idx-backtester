import nacl from "npm:tweetnacl@1.0.3";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function hexToUint8Array(hex: string) {
  return new Uint8Array(
    hex.match(/.{1,2}/g)?.map((byte) =>
      Number.parseInt(byte, 16)
    ) ?? []
  );
}

Deno.serve(async (request) => {
  if (request.method === "GET") {
    return jsonResponse({
      success: true,
      message: "Discord IDX Backtester is running",
    });
  }

  if (request.method !== "POST") {
    return jsonResponse(
      { error: "Method not allowed" },
      405
    );
  }

  const publicKey =
    Deno.env.get("DISCORD_PUBLIC_KEY");

  if (!publicKey) {
    return jsonResponse(
      { error: "DISCORD_PUBLIC_KEY belum diisi" },
      500
    );
  }

  const signature =
    request.headers.get("x-signature-ed25519");

  const timestamp =
    request.headers.get("x-signature-timestamp");

  if (!signature || !timestamp) {
    return jsonResponse(
      { error: "Discord signature tidak ditemukan" },
      401
    );
  }

  /*
   * Body harus dibaca sebagai teks mentah sebelum JSON.parse
   * agar signature Discord dapat diverifikasi.
   */
  const rawBody = await request.text();

  const message = new TextEncoder().encode(
    timestamp + rawBody
  );

  const validRequest =
    nacl.sign.detached.verify(
      message,
      hexToUint8Array(signature),
      hexToUint8Array(publicKey)
    );

  if (!validRequest) {
    return jsonResponse(
      { error: "Invalid Discord signature" },
      401
    );
  }

  const interaction = JSON.parse(rawBody);

  /*
   * Discord PING verification.
   */
  if (interaction.type === 1) {
    return jsonResponse({
      type: 1,
    });
  }

  /*
   * Respons sementara untuk slash command.
   */
  if (
    interaction.type === 2 &&
    interaction.data?.name === "backtest"
  ) {
    const tickerOption =
      interaction.data.options?.find(
        (option: { name: string }) =>
          option.name === "ticker"
      );

    const ticker = String(
      tickerOption?.value ?? "DMAS"
    ).toUpperCase();

    return jsonResponse({
      type: 4,
      data: {
        content:
          `✅ Command diterima.\n` +
          `Ticker: **${ticker}.JK**\n` +
          `Koneksi Discord → Deno Deploy berhasil.`,
      },
    });
  }

  return jsonResponse({
    type: 4,
    data: {
      content: "Command tidak dikenali.",
    },
  });
});
