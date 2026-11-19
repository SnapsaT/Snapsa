import { Capacitor } from '@capacitor/core';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';

export const isNative = () => Capacitor.isNativePlatform();

// Opens the native camera and returns a File for your existing upload code.
export async function takeNativePhoto() {
  const photo = await Camera.getPhoto({
    quality: 90,
    allowEditing: false,
    resultType: CameraResultType.Uri,
    source: CameraSource.Camera,
    saveToGallery: false,
  });
  const res = await fetch(photo.webPath);
  const blob = await res.blob();
  const ext = photo.format || 'jpeg';
  return new File([blob], `snapsa-${Date.now()}.${ext}`, { type: `image/${ext}` });
}
