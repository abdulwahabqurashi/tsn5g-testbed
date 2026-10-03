const express = require('express');
const http2 = require('http2');
const router = express.Router();

const TSN_AF_BASE = process.env.TSN_AF_URL || 'http://127.0.0.30:7777';
const TSN_AF_API = '/tsn-af/v1';

function tsnPath(path) {
  return TSN_AF_API + path;
}

/*
 * HTTP/2 client helper.
 * Open5GS SBI uses nghttp2 which only speaks HTTP/2 (h2c).
 * Node.js built-in http2 module is used instead of axios (HTTP/1.1).
 */
function h2request(method, path, body) {
  return new Promise((resolve, reject) => {
    var client;
    try {
      client = http2.connect(TSN_AF_BASE);
    } catch (err) {
      return reject(err);
    }

    client.on('error', function(err) {
      reject(err);
    });

    var headers = {
      ':method': method,
      ':path': path
    };

    if (body) {
      headers['content-type'] = 'application/json';
    }

    var req = client.request(headers);

    var status = 200;
    var chunks = [];

    req.on('response', function(hdrs) {
      status = hdrs[':status'] || 200;
    });

    req.on('data', function(chunk) {
      chunks.push(chunk);
    });

    req.on('end', function() {
      client.close();
      var raw = Buffer.concat(chunks).toString();
      var data = null;
      if (raw.length > 0) {
        try {
          data = JSON.parse(raw);
        } catch (e) {
          data = { message: raw };
        }
      }
      resolve({ status: status, data: data });
    });

    req.on('error', function(err) {
      client.close();
      reject(err);
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// GET /api/tsn/Bridge - list all bridges
router.get('/Bridge', async (req, res) => {
  try {
    var response = await h2request('GET', tsnPath('/bridges'));
    res.status(response.status).json(response.data);
  } catch (error) {
    res.status(502).json({ message: 'TSN AF unreachable' });
  }
});

// POST /api/tsn/Bridge - create bridge
router.post('/Bridge', async (req, res) => {
  try {
    var response = await h2request('POST', tsnPath('/bridges'), req.body);
    res.status(response.status).json(response.data);
  } catch (error) {
    res.status(502).json({ message: 'TSN AF unreachable' });
  }
});

// GET /api/tsn/Bridge/:id - get bridge detail
router.get('/Bridge/:id', async (req, res) => {
  try {
    var response = await h2request('GET', tsnPath('/bridges/' + req.params.id));
    res.status(response.status).json(response.data);
  } catch (error) {
    res.status(502).json({ message: 'TSN AF unreachable' });
  }
});

// DELETE /api/tsn/Bridge/:id - delete bridge
router.delete('/Bridge/:id', async (req, res) => {
  try {
    var response = await h2request('DELETE', tsnPath('/bridges/' + req.params.id));
    res.status(response.status || 204).end();
  } catch (error) {
    res.status(502).json({ message: 'TSN AF unreachable' });
  }
});

// PUT /api/tsn/Bridge/:id - update bridge
router.put('/Bridge/:id', async (req, res) => {
  try {
    var response = await h2request('PUT', tsnPath('/bridges/' + req.params.id), req.body);
    res.status(response.status).json(response.data);
  } catch (error) {
    res.status(502).json({ message: 'TSN AF unreachable' });
  }
});

// POST /api/tsn/Bridge/:id/configure - configure bridge
router.post('/Bridge/:id/configure', async (req, res) => {
  try {
    var response = await h2request('POST',
      tsnPath('/bridges/' + req.params.id + '/configure'), req.body);
    res.status(response.status).json(response.data);
  } catch (error) {
    res.status(502).json({ message: 'TSN AF unreachable' });
  }
});

// POST /api/tsn/Bridge/:bridgeId/Port - create port
router.post('/Bridge/:bridgeId/Port', async (req, res) => {
  try {
    var response = await h2request('POST',
      tsnPath('/bridges/' + req.params.bridgeId + '/ports'), req.body);
    res.status(response.status).json(response.data);
  } catch (error) {
    res.status(502).json({ message: 'TSN AF unreachable' });
  }
});

// GET /api/tsn/Bridge/:bridgeId/Port/:portId - get port
router.get('/Bridge/:bridgeId/Port/:portId', async (req, res) => {
  try {
    var response = await h2request('GET',
      tsnPath('/bridges/' + req.params.bridgeId + '/ports/' + req.params.portId));
    res.status(response.status).json(response.data);
  } catch (error) {
    res.status(502).json({ message: 'TSN AF unreachable' });
  }
});

// DELETE /api/tsn/Bridge/:bridgeId/Port/:portId - delete port
router.delete('/Bridge/:bridgeId/Port/:portId', async (req, res) => {
  try {
    var response = await h2request('DELETE',
      tsnPath('/bridges/' + req.params.bridgeId + '/ports/' + req.params.portId));
    res.status(response.status || 204).end();
  } catch (error) {
    res.status(502).json({ message: 'TSN AF unreachable' });
  }
});

// POST /api/tsn/Bridge/:bridgeId/Port/:portId/configure - configure port
router.post('/Bridge/:bridgeId/Port/:portId/configure', async (req, res) => {
  try {
    var response = await h2request('POST',
      tsnPath('/bridges/' + req.params.bridgeId + '/ports/' + req.params.portId + '/configure'),
      req.body);
    res.status(response.status).json(response.data);
  } catch (error) {
    res.status(502).json({ message: 'TSN AF unreachable' });
  }
});

// POST /api/tsn/Bridge/:id/qos-mapping - configure QoS mapping
router.post('/Bridge/:id/qos-mapping', async (req, res) => {
  try {
    var response = await h2request('POST',
      tsnPath('/bridges/' + req.params.id + '/qos-mapping'), req.body);
    res.status(response.status).json(response.data);
  } catch (error) {
    res.status(502).json({ message: 'TSN AF unreachable' });
  }
});

// POST /api/tsn/Bridge/:id/tsc-assistance - configure TSC assistance
router.post('/Bridge/:id/tsc-assistance', async (req, res) => {
  try {
    var response = await h2request('POST',
      tsnPath('/bridges/' + req.params.id + '/tsc-assistance'), req.body);
    res.status(response.status).json(response.data);
  } catch (error) {
    res.status(502).json({ message: 'TSN AF unreachable' });
  }
});

// POST /api/tsn/Bridge/:id/stream-reservations - configure stream reservations
router.post('/Bridge/:id/stream-reservations', async (req, res) => {
  try {
    var response = await h2request('POST',
      tsnPath('/bridges/' + req.params.id + '/stream-reservations'), req.body);
    res.status(response.status).json(response.data);
  } catch (error) {
    res.status(502).json({ message: 'TSN AF unreachable' });
  }
});

// POST /api/tsn/Bridge/:bridgeId/Port/:portId/gcl - configure GCL on port
router.post('/Bridge/:bridgeId/Port/:portId/gcl', async (req, res) => {
  try {
    var response = await h2request('POST',
      tsnPath('/bridges/' + req.params.bridgeId + '/ports/' + req.params.portId + '/gcl'),
      req.body);
    res.status(response.status).json(response.data);
  } catch (error) {
    res.status(502).json({ message: 'TSN AF unreachable' });
  }
});

// POST /api/tsn/Bridge/:bridgeId/Port/:portId/psfp - configure PSFP on port
router.post('/Bridge/:bridgeId/Port/:portId/psfp', async (req, res) => {
  try {
    var response = await h2request('POST',
      tsnPath('/bridges/' + req.params.bridgeId + '/ports/' + req.params.portId + '/psfp'),
      req.body);
    res.status(response.status).json(response.data);
  } catch (error) {
    res.status(502).json({ message: 'TSN AF unreachable' });
  }
});

// GET /api/tsn/Analytics - fetch TSN analytics
router.get('/Analytics', async (req, res) => {
  try {
    var response = await h2request('GET', tsnPath('/analytics'));
    res.status(response.status).json(response.data);
  } catch (error) {
    res.status(502).json({ message: 'TSN AF unreachable' });
  }
});

// GET /api/tsn/Interface - list physical network interfaces
router.get('/Interface', async (req, res) => {
  try {
    var response = await h2request('GET', tsnPath('/interfaces'));
    res.status(response.status).json(response.data);
  } catch (error) {
    res.status(502).json({ message: 'TSN AF unreachable' });
  }
});

module.exports = router;
