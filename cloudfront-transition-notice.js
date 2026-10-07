function handler(event) {
  var body = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Glean</title></head><body><font face="Times New Roman, Times, serif">glean is transitioning outside of school hours instead of inside school hours<br><br>check later after school hours, the reason for this is because to keep users safe</font></body></html>';

  return {
    statusCode: 200,
    statusDescription: 'OK',
    headers: {
      'content-type': { value: 'text/html; charset=utf-8' },
      'cache-control': { value: 'no-store, max-age=0' }
    },
    body: body
  };
}
