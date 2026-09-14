// Proxies Daily Docket <-> Notion Task List database.
//
// Notion's REST API doesn't send CORS headers, so the browser can't call it
// directly. This Worker sits in between: the browser calls this Worker
// (which does allow CORS, locked to one origin), and the Worker calls Notion
// using a token that lives only as a Worker secret.
//
// Routes:
//   GET  /tasks            -> open tasks from the database (Done/Paused excluded)
//   POST /tasks            -> create a new task
//   PATCH /tasks/:pageId    -> update Assigned Date and/or Status on one task
//   GET  /meta              -> available Priority/Project select options

const NOTION_VERSION = '2022-06-28';
const NOTION_API = 'https://api.notion.com/v1';

function corsHeaders(origin, allowedOrigin) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
  if (origin === allowedOrigin) {
    headers['Access-Control-Allow-Origin'] = allowedOrigin;
  }
  return headers;
}

function notionHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

function plainText(richTextArray) {
  return (richTextArray || []).map(t => t.plain_text).join('');
}

function pageToTask(page) {
  const props = page.properties;
  return {
    id: page.id,
    text: plainText(props.Task && props.Task.title),
    status: (props.Status && props.Status.status && props.Status.status.name) || null,
    priority: (props.Priority && props.Priority.select && props.Priority.select.name) || null,
    project: (props.Project && props.Project.select && props.Project.select.name) || null,
    assignedDate: (props['Assigned Date'] && props['Assigned Date'].date && props['Assigned Date'].date.start) || null,
  };
}

async function handleGetTasks(env) {
  const res = await fetch(`${NOTION_API}/databases/${env.NOTION_DATABASE_ID}/query`, {
    method: 'POST',
    headers: notionHeaders(env.NOTION_TOKEN),
    body: JSON.stringify({
      filter: {
        and: [
          { property: 'Status', status: { does_not_equal: 'Done' } },
          { property: 'Status', status: { does_not_equal: 'Paused' } },
        ],
      },
      sorts: [{ property: 'Assigned Date', direction: 'ascending' }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    return new Response(JSON.stringify({ error: 'Notion query failed', detail }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const json = await res.json();
  const tasks = json.results.map(pageToTask);
  return new Response(JSON.stringify(tasks), { headers: { 'Content-Type': 'application/json' } });
}

async function handleGetMeta(env) {
  const res = await fetch(`${NOTION_API}/databases/${env.NOTION_DATABASE_ID}`, {
    headers: notionHeaders(env.NOTION_TOKEN),
  });

  if (!res.ok) {
    const detail = await res.text();
    return new Response(JSON.stringify({ error: 'Notion schema fetch failed', detail }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const json = await res.json();
  const priorities = ((json.properties.Priority && json.properties.Priority.select && json.properties.Priority.select.options) || []).map(o => o.name);
  const projects = ((json.properties.Project && json.properties.Project.select && json.properties.Project.select.options) || []).map(o => o.name);
  return new Response(JSON.stringify({ priorities, projects }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleCreateTask(body, env) {
  const text = (body.text || '').trim();
  if (!text) {
    return new Response(JSON.stringify({ error: 'text is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const properties = {
    Task: { title: [{ text: { content: text } }] },
  };
  if (body.priority) properties['Priority'] = { select: { name: body.priority } };
  if (body.project) properties['Project'] = { select: { name: body.project } };
  if (body.status) properties['Status'] = { status: { name: body.status } };
  if (body.assignedDate) properties['Assigned Date'] = { date: { start: body.assignedDate } };

  const res = await fetch(`${NOTION_API}/pages`, {
    method: 'POST',
    headers: notionHeaders(env.NOTION_TOKEN),
    body: JSON.stringify({
      parent: { database_id: env.NOTION_DATABASE_ID },
      properties,
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    return new Response(JSON.stringify({ error: 'Notion create failed', detail }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const page = await res.json();
  return new Response(JSON.stringify(pageToTask(page)), { headers: { 'Content-Type': 'application/json' } });
}

async function handlePatchTask(pageId, body, env) {
  const properties = {};

  if (body.assignedDate !== undefined) {
    properties['Assigned Date'] = body.assignedDate
      ? { date: { start: body.assignedDate } }
      : { date: null };
  }
  if (body.status !== undefined) {
    properties['Status'] = { status: { name: body.status } };
  }
  if (body.priority !== undefined) {
    properties['Priority'] = body.priority ? { select: { name: body.priority } } : { select: null };
  }
  if (body.project !== undefined) {
    properties['Project'] = body.project ? { select: { name: body.project } } : { select: null };
  }

  const pageUpdate = { properties };
  if (body.archived !== undefined) pageUpdate.archived = !!body.archived;

  if (Object.keys(properties).length === 0 && body.archived === undefined) {
    return new Response(JSON.stringify({ error: 'No recognized fields to update' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: 'PATCH',
    headers: notionHeaders(env.NOTION_TOKEN),
    body: JSON.stringify(pageUpdate),
  });

  if (!res.ok) {
    const detail = await res.text();
    return new Response(JSON.stringify({ error: 'Notion update failed', detail }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    const url = new URL(request.url);
    let response;

    try {
      if (request.method === 'GET' && url.pathname === '/tasks') {
        response = await handleGetTasks(env);
      } else if (request.method === 'GET' && url.pathname === '/meta') {
        response = await handleGetMeta(env);
      } else if (request.method === 'POST' && url.pathname === '/tasks') {
        const body = await request.json();
        response = await handleCreateTask(body, env);
      } else if (request.method === 'PATCH' && url.pathname.startsWith('/tasks/')) {
        const pageId = url.pathname.slice('/tasks/'.length);
        const body = await request.json();
        response = await handlePatchTask(pageId, body, env);
      } else {
        response = new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    } catch (e) {
      response = new Response(JSON.stringify({ error: 'Worker error', detail: String(e) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const finalResponse = new Response(response.body, response);
    Object.entries(cors).forEach(([key, value]) => finalResponse.headers.set(key, value));
    return finalResponse;
  },
};
