export async function collectBotDirectory({ listDevices, listBots }) {
  const devices = [];
  let cursor = null;
  do {
    const page = await listDevices({ limit: 200, cursor });
    devices.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);

  const botsByDevice = new Array(devices.length);
  const errorsByDevice = new Array(devices.length);
  let next = 0;
  async function readDevices() {
    while (next < devices.length) {
      const index = next++;
      const device = devices[index];
      if (!device.online) continue;
      try {
        const bots = await listBots(device.deviceId);
        botsByDevice[index] = bots.map((bot) => ({
          ...bot,
          description: bot.description ?? '',
          deviceName: device.displayName || device.deviceId,
          ...(device.platform ? { platform: device.platform } : {}),
          online: true,
        }));
      } catch (err) {
        errorsByDevice[index] = {
          deviceId: device.deviceId,
          code: typeof err?.code === 'string' ? err.code : 'INTERNAL',
          ...(typeof err?.message === 'string' ? { message: err.message } : {}),
        };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, devices.length) }, readDevices));
  return { devices, bots: botsByDevice.flatMap((items) => items ?? []), errors: errorsByDevice.filter(Boolean) };
}
