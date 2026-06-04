(function () {
  const C = document.createElement('canvas');
  C.width = 64;
  C.height = 64;
  const ctx = C.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  function fill(x, y, w, h, col) {
    ctx.fillStyle = col;
    ctx.fillRect(x, y, w, h);
  }

  const SKIN  = '#C68642';
  const HAIR  = '#5C4033';
  const EYE   = '#462C1E';
  const SHIRT = '#1C7FCA';
  const PANTS = '#16518B';
  const SHOE  = '#664C33';

  // HEAD — top region (y 0-7)
  fill(8,  0, 8, 8, HAIR);   // top of head
  fill(16, 0, 8, 8, SKIN);   // bottom face of head
  // HEAD — face ring (y 8-15)
  fill(0,  8, 8, 8, HAIR);   // right side
  fill(8,  8, 8, 8, SKIN);   // front face
  fill(16, 8, 8, 8, HAIR);   // left side
  fill(24, 8, 8, 8, HAIR);   // back
  // Eyes & mouth on front face (pixel coords within 8,8 → 16,16)
  fill(9,  10, 2, 2, EYE);
  fill(13, 10, 2, 2, EYE);
  fill(10, 13, 4, 1, EYE);

  // BODY (16,16)-(55,31)
  fill(16, 20, 4, 12, SHIRT);  // right
  fill(20, 20, 8, 12, SHIRT);  // front
  fill(28, 20, 4, 12, SHIRT);  // left
  fill(32, 20, 8, 12, SHIRT);  // back
  fill(20, 16, 8, 4,  SHIRT);  // top
  fill(28, 16, 8, 4,  SHIRT);  // bottom

  // RIGHT ARM (40,16)-(55,31)
  fill(44, 16, 4, 4, SKIN);    // top
  fill(48, 16, 4, 4, SKIN);    // bottom
  fill(40, 20, 4, 12, SKIN);   // right
  fill(44, 20, 4, 12, SKIN);   // front
  fill(48, 20, 4, 12, SKIN);   // back
  fill(52, 20, 4, 12, SKIN);   // left

  // RIGHT LEG (0,16)-(15,31)
  fill(4,  16, 4, 4, PANTS);   // top
  fill(8,  16, 4, 4, SHOE);    // bottom
  fill(0,  20, 4, 12, PANTS);  // right
  fill(4,  20, 4, 12, PANTS);  // front
  fill(8,  20, 4, 12, PANTS);  // back
  fill(12, 20, 4, 12, PANTS);  // left

  // LEFT ARM — 64x64 area (32,48)-(47,63)
  fill(36, 48, 4, 4, SKIN);
  fill(40, 48, 4, 4, SKIN);
  fill(32, 52, 4, 12, SKIN);
  fill(36, 52, 4, 12, SKIN);
  fill(40, 52, 4, 12, SKIN);
  fill(44, 52, 4, 12, SKIN);

  // LEFT LEG — 64x64 area (16,48)-(31,63)
  fill(20, 48, 4, 4, PANTS);
  fill(24, 48, 4, 4, SHOE);
  fill(16, 52, 4, 12, PANTS);
  fill(20, 52, 4, 12, PANTS);
  fill(24, 52, 4, 12, PANTS);
  fill(28, 52, 4, 12, PANTS);

  window.DEFAULT_PLAYER_SKIN = C.toDataURL('image/png');

  window.savePlayerSkin = function (dataUrl) {
    try { localStorage.setItem('playerSkin', dataUrl); } catch (e) {}
  };

  window.loadPlayerSkin = function () {
    try {
      return localStorage.getItem('playerSkin') || window.DEFAULT_PLAYER_SKIN;
    } catch (e) {
      return window.DEFAULT_PLAYER_SKIN;
    }
  };
}());
