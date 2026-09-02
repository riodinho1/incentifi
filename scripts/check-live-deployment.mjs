const urls = ['https://incentifi.vercel.app', 'https://incentifi.fun'];

async function checkUrl(baseUrl) {
  try {
    const res = await fetch(baseUrl, { cache: 'no-store' });
    const html = await res.text();
    const scriptMatch = html.match(/src="(\/assets\/index-[^"]+\.js)"/);
    if (!scriptMatch) {
      console.log(`[${baseUrl}] No script tag found`);
      return;
    }
    const scriptUrl = baseUrl + scriptMatch[1];
    console.log(`[${baseUrl}] Found script: ${scriptUrl}`);
    const scriptRes = await fetch(scriptUrl, { cache: 'no-store' });
    const scriptText = await scriptRes.text();
    
    const hasOnePercent = scriptText.includes('1.0% Creator / 1.0% Loss Pool') || scriptText.includes('1% Creator / 1% Loss Pool');
    const hasPointFive = scriptText.includes('0.5% Creator') || scriptText.includes('0.5% Loss');
    const hasFactory = scriptText.includes('0x9fcea653c6f31c82606582b22da82b39f61f9c0e');
    const hasRouter = scriptText.includes('0xbba0384bf34b5cc26daa2c06cdf765bbdeb2acdf');
    const hasLossPool = scriptText.includes('0x697bda9db5a297a9cd9ed969bbf2549d0527dcdf');
    
    console.log(`[${baseUrl}] Results:`);
    console.log(`  - 1% Creator / 1% Loss Pool present: ${hasOnePercent}`);
    console.log(`  - 0.5% Creator/Loss present: ${hasPointFive}`);
    console.log(`  - Verified Factory (0x9fce...): ${hasFactory}`);
    console.log(`  - Verified Router (0xbba0...): ${hasRouter}`);
    console.log(`  - Verified LossRewardPool (0x697b...): ${hasLossPool}`);
  } catch (err) {
    console.error(`[${baseUrl}] Error: ${err.message}`);
  }
}

async function main() {
  for (const url of urls) {
    await checkUrl(url);
  }
}

main();
