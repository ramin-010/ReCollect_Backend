import * as Y from 'yjs';

const MAX_NODES = 8;
const MAX_TEXT_LENGTH = 300;

function truncateText(text: string, maxLength: number = MAX_TEXT_LENGTH): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

function truncateNode(node: any): any {
  if (!node) return null;
  
  switch (node.type) {
    case 'paragraph':
    case 'heading':
    case 'blockquote':
      if (node.content) {
        const text = node.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text || '')
          .join('');
        if (text.length > MAX_TEXT_LENGTH) {
          return {
            ...node,
            content: [{ type: 'text', text: truncateText(text) }]
          };
        }
      }
      return node;
      
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return {
        ...node,
        content: (node.content || []).slice(0, 5).map((item: any) => ({
          ...item,
          content: item.content?.map((p: any) => truncateNode(p))
        }))
      };
      
    case 'image':
    case 'resizableImage':
      return {
        type: node.type,
        attrs: {
          src: node.attrs?.src,
          imageId: node.attrs?.imageId,
        }
      };
      
    case 'codeBlock':
      const code = node.content?.[0]?.text || '';
      return {
        ...node,
        content: [{ type: 'text', text: truncateText(code, 200) }]
      };
      
    default:
      return node;
  }
}

function yjsStateToJson(yjsStateBase64: string): any {
  const ydoc = new Y.Doc();
  const state = Buffer.from(yjsStateBase64, 'base64');
  Y.applyUpdate(ydoc, state);
  
  const fragment = ydoc.getXmlFragment('default');
  const nodes: any[] = [];
  
  function extractPlainText(element: any): string {
    if (!element) return '';
    
    // Check if it's Y.XmlText (text content)
    if (element instanceof Y.XmlText || element.constructor?.name === 'XmlText') {
      return element.toJSON ? element.toJSON() : (element.toString() || '');
    }
    
    // For text strings
    if (typeof element === 'string') {
      return element;
    }
    
    // For elements, check if they have a toJSON that returns string
    if (element.toJSON && typeof element.toJSON() === 'string') {
      return element.toJSON();
    }
    
    // Recursively get text from children
    let text = '';
    if (element.toArray) {
      for (const child of element.toArray()) {
        text += extractPlainText(child);
      }
    }
    return text;
  }
  
  // Strip XML tags from text (e.g., "<bold>text</bold>" -> "text")
  function stripXmlTags(str: string): string {
    return str.replace(/<[^>]+>/g, '');
  }
  
  function xmlToJson(element: any): any {
    if (!element) return null;
    
    const constructorName = element.constructor?.name;
    const nodeName = element.nodeName;
    
    // Check for Y.XmlText (text node)
    if (element instanceof Y.XmlText || constructorName === 'XmlText') {
      const rawText = element.toJSON ? element.toJSON() : element.toString();
      const text = stripXmlTags(rawText);
      return text ? { type: 'text', text } : null;
    }
    
    // Get node name for XML elements
    if (!nodeName) {
      // It might be a plain text string
      const str = element.toString ? element.toString() : String(element);
      if (str && !str.startsWith('<')) {
        return { type: 'text', text: str };
      }
      return null;
    }
    
    // Skip inline formatting marks - extract their text content only
    const inlineMarks = ['bold', 'italic', 'underline', 'strike', 'code', 'link', 'highlight', 'textStyle'];
    if (inlineMarks.includes(nodeName)) {
      const text = extractPlainText(element);
      return text ? { type: 'text', text } : null;
    }
    
    // Get attributes
    const attrs: any = {};
    if (element.getAttributes) {
      const elementAttrs = element.getAttributes();
      Object.keys(elementAttrs).forEach(key => {
        attrs[key] = elementAttrs[key];
      });
    }
    
    // Get children
    const content: any[] = [];
    if (element.toArray) {
      for (const child of element.toArray()) {
        const childJson = xmlToJson(child);
        if (childJson) content.push(childJson);
      }
    }
    
    return {
      type: nodeName,
      ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
      ...(content.length > 0 ? { content } : {})
    };
  }
  
  if (fragment.toArray) {
    for (const child of fragment.toArray()) {
      const json = xmlToJson(child);
      if (json) nodes.push(json);
    }
  }
  
  ydoc.destroy();
  return { type: 'doc', content: nodes };
}

export function generatePreviewState(yjsState: string): string | null {
  if (!yjsState) return null;
  
  try {
    const json = yjsStateToJson(yjsState);
    
    if (!json?.content || !Array.isArray(json.content)) {
      return null;
    }
    
    const previewNodes = json.content
      .slice(0, MAX_NODES)
      .map(truncateNode)
      .filter(Boolean);
    
    const previewDoc = { type: 'doc', content: previewNodes };
    return JSON.stringify(previewDoc);
  } catch (err) {
    console.error('[previewUtils] Failed to generate preview:', err);
    return null;
  }
}
