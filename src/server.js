const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const categories = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'categories.json'), 'utf-8'));
const products = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'products.json'), 'utf-8'));
const fulfillment = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'fulfillment.json'), 'utf-8'));
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function withinDirectory(parent, target) {
  const relative = path.relative(parent, target);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function serveStaticFile(res, filePath) {
  let data;
  try {
    data = fs.readFileSync(filePath);
  } catch (error) {
    return false;
  }

  const extension = path.extname(filePath);
  const contentType = MIME_TYPES[extension] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(data);
  return true;
}

const PORT = process.env.PORT || 3000;
const ALLOWED_METHODS = ['GET', 'POST', 'OPTIONS'];

function sendJson(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function notFound(res) {
  sendJson(res, 404, { error: 'Not Found' });
}

function methodNotAllowed(res) {
  sendJson(res, 405, { error: 'Method Not Allowed' });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(body);
        resolve(parsed);
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function calculateCartTotals(cartItems) {
  const items = [];
  let subtotal = 0;

  for (const item of cartItems) {
    const product = products.find(p => p.id === item.productId);
    if (!product) {
      throw new Error(`Product not found: ${item.productId}`);
    }
    if (!product.isAvailable) {
      throw new Error(`Product is not available: ${product.name}`);
    }

    const quantity = Number(item.quantity) || 0;
    if (quantity <= 0) {
      throw new Error(`Invalid quantity for product ${product.name}`);
    }

    const lineTotal = product.price * quantity;
    subtotal += lineTotal;
    items.push({
      productId: product.id,
      name: product.name,
      quantity,
      unitPrice: product.price,
      lineTotal,
    });
  }

  return {
    items,
    subtotal,
  };
}

function calculateDeliveryCost(mode, optionId) {
  if (mode === 'pickup') {
    const pickupPoint = fulfillment.pickupPoints.find(point => point.id === optionId);
    if (!pickupPoint) {
      throw new Error('Unknown pickup point');
    }
    return { type: 'pickup', pickupPoint, deliveryCost: 0 };
  }

  if (mode === 'delivery') {
    const zone = fulfillment.deliveryZones.find(z => z.id === optionId);
    if (!zone) {
      throw new Error('Unknown delivery zone');
    }
    return { type: 'delivery', zone, deliveryCost: zone.price };
  }

  throw new Error('Unknown fulfillment mode');
}

const server = http.createServer(async (req, res) => {
  if (!ALLOWED_METHODS.includes(req.method)) {
    return methodNotAllowed(res);
  }

  if (req.method === 'OPTIONS') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = requestUrl.pathname.replace(/\/$/, '') || '/';

  try {
    if (req.method === 'GET') {
      const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
      const candidatePath = path.normalize(path.join(PUBLIC_DIR, relativePath));

      if (withinDirectory(PUBLIC_DIR, candidatePath) && fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
        serveStaticFile(res, candidatePath);
        return;
      }
    }

    if (req.method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/categories') {
      sendJson(res, 200, { categories });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/products') {
      const categoryId = requestUrl.searchParams.get('categoryId');
      const onlyAvailable = requestUrl.searchParams.get('onlyAvailable') === 'true';

      const filtered = products.filter(product => {
        if (categoryId && product.categoryId !== categoryId) {
          return false;
        }
        if (onlyAvailable && !product.isAvailable) {
          return false;
        }
        return true;
      });

      sendJson(res, 200, { products: filtered });
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/api/products/')) {
      const productId = pathname.split('/').pop();
      const product = products.find(p => p.id === productId);
      if (!product) {
        notFound(res);
        return;
      }
      sendJson(res, 200, { product });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/fulfillment-options') {
      sendJson(res, 200, fulfillment);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/orders') {
      const body = await parseBody(req);
      const { cartItems = [], customer = {}, fulfillmentMode, fulfillmentOptionId, comment = '' } = body;

      if (!Array.isArray(cartItems) || cartItems.length === 0) {
        sendJson(res, 400, { error: 'Cart is empty' });
        return;
      }

      if (!fulfillmentMode || !fulfillmentOptionId) {
        sendJson(res, 400, { error: 'Fulfillment data is required' });
        return;
      }

      if (!customer || !customer.name || !customer.phone) {
        sendJson(res, 400, { error: 'Customer name and phone are required' });
        return;
      }

      const totals = calculateCartTotals(cartItems);
      const delivery = calculateDeliveryCost(fulfillmentMode, fulfillmentOptionId);
      const orderTotal = totals.subtotal + delivery.deliveryCost;

      const order = {
        id: `${Date.now()}`,
        createdAt: new Date().toISOString(),
        customer: {
          name: customer.name,
          phone: customer.phone,
          email: customer.email || null,
          address: customer.address || null,
        },
        cart: totals.items,
        fulfillment: {
          mode: delivery.type,
          pickupPoint: delivery.pickupPoint || null,
          deliveryZone: delivery.zone || null,
          deliveryCost: delivery.deliveryCost,
        },
        subtotal: totals.subtotal,
        total: orderTotal,
        comment,
        paymentStatus: 'pending',
        orderStatus: 'new',
      };

      sendJson(res, 201, { order, message: 'Order placed. Менеджер свяжется для подтверждения.' });
      return;
    }

    notFound(res);
  } catch (error) {
    console.error('Request error', error.message);
    sendJson(res, 400, { error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
