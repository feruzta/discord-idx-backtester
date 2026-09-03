Deno.serve(() => {
  return new Response(
    JSON.stringify({
      success: true,
      message: "Discord IDX Backtester is running"
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    }
  );
});
