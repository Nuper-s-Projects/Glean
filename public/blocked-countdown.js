const root = document.querySelector('[data-next-open]');
const hoursNode = document.querySelector('#countdown-hours');
const minutesNode = document.querySelector('#countdown-minutes');
const secondsNode = document.querySelector('#countdown-seconds');

if (root && hoursNode && minutesNode && secondsNode) {
  const nextOpenAt = Number(root.dataset.nextOpen);
  const update = () => {
    const remaining = Math.max(0, Math.ceil((nextOpenAt - Date.now()) / 1000));
    hoursNode.textContent = String(Math.floor(remaining / 3600)).padStart(2, '0');
    minutesNode.textContent = String(Math.floor((remaining % 3600) / 60)).padStart(2, '0');
    secondsNode.textContent = String(remaining % 60).padStart(2, '0');
    if (remaining === 0) window.location.replace('/');
  };
  update();
  window.setInterval(update, 1000);
}
