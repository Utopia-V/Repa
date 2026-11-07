// In a lesson the course stays quiet: only the row of tiles around the KP in hand.
window.paints = window.paints ?? {};
window.paints.strip = {
  mount() {},
  unmount(figure) { figure.replaceChildren(); },
  update(figure, { progress }) {
    const at = Math.max(0, progress.findIndex((entry) => entry.state === "current"));
    const from = at - (at % 10);
    figure.replaceChildren(window.Tile.field(progress.slice(from, from + 10), 10, 32, from));
  },
};
