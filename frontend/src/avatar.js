const SIZE = 128;

// Recorta o centro da imagem em quadrado e reduz para um JPEG pequeno (também remove metadados).
export async function avatarBlob(file) {
  if (!file.type.startsWith('image/')) throw new Error('Escolha uma imagem');
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // PNG transparente vira fundo branco no JPEG
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, SIZE, SIZE);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!blob) throw new Error('Não foi possível processar a imagem');
  return blob;
}
