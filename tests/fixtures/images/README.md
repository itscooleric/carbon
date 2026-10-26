# Raster fixtures

`grid.png`, `grid.jpg` and `grid.webp` are original synthetic 32 × 20 RGB fixtures generated for these tests. At coordinate `(x, y)`, the source pixel is `(7*x, 11*y, 4*(x+y))`. They contain no user images or third-party artwork. The checked-in bytes are the portable-export comparison baseline; tests require no image-generation library at runtime.

`progressive.jpg` is a progressive re-encoding of the synthetic JPEG above. `tall.png` is a 32 × 2000 solid RGB (77, 99, 125) fixture for asynchronous Viewer scroll restoration. Both are generated test data; their checked-in bytes require no runtime image-generation dependency.
