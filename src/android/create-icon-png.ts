import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { iconComponents } from './icon-components';
import type { AndroidIdentity } from '../types';

const components = iconComponents;

function shapeMarkup(shape: AndroidIdentity['iconShape']): string {
  if (shape === 'circle') return '<circle cx="256" cy="256" r="236" fill="BACKGROUND"/>';
  if (shape === 'squircle') return '<rect x="20" y="20" width="472" height="472" rx="150" fill="BACKGROUND"/>';
  return '<rect x="20" y="20" width="472" height="472" rx="112" fill="BACKGROUND"/>';
}

function uploadedArtwork(identity: AndroidIdentity): string {
  const clipShape = shapeMarkup(identity.iconShape).replace(/fill="[^"]+"/, 'fill="#ffffff"');
  const outline = shapeMarkup(identity.iconShape).replace(/fill="[^"]+"/, 'fill="none" stroke="#ffffff" stroke-opacity=".46" stroke-width="3"');
  return `<defs><clipPath id="codexa-icon-clip">${clipShape}</clipPath><linearGradient id="codexa-icon-gloss" x1="0" y1="0" x2="0.9" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".24"/><stop offset=".34" stop-color="#ffffff" stop-opacity=".04"/><stop offset="1" stop-color="#000000" stop-opacity=".22"/></linearGradient><filter id="codexa-icon-shadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="7" stdDeviation="9" flood-color="#000000" flood-opacity=".3"/></filter></defs><rect width="512" height="512" fill="${identity.iconBackground}"/>${shapeMarkup(identity.iconShape).replace(/fill="[^"]+"/, `fill="${identity.iconBackground}" filter="url(#codexa-icon-shadow)"`)}<image href="${identity.uploadedIcon}" x="20" y="20" width="472" height="472" preserveAspectRatio="xMidYMid slice" clip-path="url(#codexa-icon-clip)"/><rect x="20" y="20" width="472" height="472" fill="url(#codexa-icon-gloss)" clip-path="url(#codexa-icon-clip)"/>${outline}`;
}

function svgFor(identity: AndroidIdentity): string {
  const mask = shapeMarkup(identity.iconShape).replace('BACKGROUND', identity.iconBackground);
  if (identity.uploadedIcon) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${uploadedArtwork(identity)}</svg>`;
  }
  const Component = components[identity.iconName] ?? components.Code2;
  const icon = renderToStaticMarkup(createElement(Component, { size: 220, color: identity.iconForeground, strokeWidth: 1.8, 'aria-hidden': true }));
  const inner = icon.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${mask}<svg x="146" y="146" width="220" height="220" viewBox="0 0 24 24" fill="none" stroke="${identity.iconForeground}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg></svg>`;
}

async function loadIconImage(identity: AndroidIdentity): Promise<HTMLImageElement> {
  const image = new Image();
  const svg = svgFor(identity);
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('تعذر تجهيز صورة الأيقونة.'));
  });
  return image;
}

function imageToPng(image: HTMLImageElement, size: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('تعذر تجهيز صورة الأيقونة في هذا المتصفح.');
  context.drawImage(image, 0, 0, size, size);
  return canvas.toDataURL('image/png');
}

export async function createIconPng(identity: AndroidIdentity, size = 512): Promise<string> {
  return imageToPng(await loadIconImage(identity), size);
}

export async function createIconPngPair(identity: AndroidIdentity): Promise<{ iconPng: string; iconPng192: string }> {
  const image = await loadIconImage(identity);
  return { iconPng: imageToPng(image, 512), iconPng192: imageToPng(image, 192) };
}
