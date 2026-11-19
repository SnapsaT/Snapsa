// public/sw.js - Service Worker for Snapsa Offline Video Cache

const CACHE_NAME = 'snapsa-videos-v1';
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.m3u8', '.ts'];

// Install: Claim clients immediately
self.addEventListener('install', (event) => {
  console.log('[SW] Installing...');
  self.skipWaiting();
});

// Activate: Take control of all clients
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating...');
  event.waitUntil(self.clients.claim());
  
  // Clean up old caches
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
    })
  );
});

// Fetch: Intercept video requests
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  
  // Only handle video/audio requests
  const isVideo = VIDEO_EXTENSIONS.some(ext => 
    url.pathname.toLowerCase().includes(ext)
  );
  
  if (!isVideo) return;
  
  event.respondWith(handleVideoRequest(request));
});

async function handleVideoRequest(request) {
  const cache = await caches.open(CACHE_NAME);
  
  try {
    // Try network first (for fresh content)
    const networkResponse = await fetch(request);
    
    if (networkResponse.ok) {
      // Clone and cache the response
      // Note: We must clone before reading the body
      const responseToCache = networkResponse.clone();
      
      // Only cache successful GET requests
      if (request.method === 'GET') {
        await cache.put(request, responseToCache);
      }
      
      return networkResponse;
    }
    
    throw new Error('Network response not ok');
    
  } catch (error) {
    // Network failed - try cache
    console.log('[SW] Network failed, trying cache:', request.url);
    const cachedResponse = await cache.match(request);
    
    if (cachedResponse) {
      console.log('[SW] Serving from cache:', request.url);
      return cachedResponse;
    }
    
    // Nothing in cache - return offline error
    console.warn('[SW] Not in cache:', request.url);
    return new Response('Offline - Video not cached', { 
      status: 503, 
      statusText: 'Service Unavailable' 
    });
  }
}

// Handle messages from main thread
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});