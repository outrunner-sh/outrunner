// outrunner.neev.ai was the app's first address. Old bookmarks, links and
// desktop apps still use it, so it sends every request to the same path on
// app.outrunner.sh. Nothing else runs here.
export default {
  fetch(request) {
    const url = new URL(request.url);
    url.hostname = "app.outrunner.sh";
    url.protocol = "https:";
    url.port = "";
    return Response.redirect(url.toString(), 301);
  },
};
