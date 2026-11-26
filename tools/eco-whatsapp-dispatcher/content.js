(() => {
  const page = whatsappPage();

  async function poll() {
    try {
      if (page.ready()) await chrome.runtime.sendMessage({ type: 'poll' });
    } catch {
      // Service worker restarts and transient disconnects must never submit a
      // second message. The lease in ECO determines whether a job can retry.
    }
    setTimeout(poll, 5000);
  }
  void poll();
})();
