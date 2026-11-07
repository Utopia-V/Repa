// The course as one field of tiles: dots on day one, woven after a year. Painted from state only.
window.paints = window.paints ?? {};
window.paints.lattice = {
  mount() {},
  unmount(figure) { figure.replaceChildren(); },
  update(figure, { progress }) {
    figure.replaceChildren(window.Tile.field(progress, 10, 32));
  },
};
