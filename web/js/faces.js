/* Faces from the January 2007 Homestead Furniture Making Contest avatars.
 *
 * Only the winners who added an image to their head had a custom face:
 * Miked, Cadi, ToaZuku and PoliceModlers.  The textures are the decal
 * assets referenced by the recovered avatar models (Dynabroth/VoxelizedBits
 * reupload 13678394817), fetched through the public Roblox thumbnail API.
 * Asset IDs: Miked 8399918083, Cadi 13678347738, ToaZuku 8400024938,
 * PoliceModlers 13678341537.  The classic face is the rig's shipped
 * content/textures/face.png.
 */
window.RBLX_FACES = [
  /* Miked's recovered art is 256x135 (alpha y79..214), not square.  Use the
   * classic face's display ratio (art occupies ~69% of the patch height) and
   * center a 196px window on it: y48..245 maps to v 0.0442..0.8113.  This
   * leaves margins instead of stretching the face to the head edges. */
  { id: 'miked', name: "Miked", src: 'content/faces/miked-face.png',
    vStart: 0.044212, vSpan: 0.767045 },
  { id: 'cadi', name: "Cadi", src: 'content/faces/cadi-face.png' },
  { id: 'toazuku', name: "ToaZuku", src: 'content/faces/toazuku-face.png' },
  { id: 'police-modlers', name: "PoliceModlers", src: 'content/faces/police-modlers-face.png' },
];
