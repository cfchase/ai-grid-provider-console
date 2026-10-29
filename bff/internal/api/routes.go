package api

import (
	"fmt"
	"net/http"
	"strings"
)

// registerRoutes attaches every authenticated endpoint. Keep this list in sync
// with docs/plan/bff-api.md.
func (a *App) registerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET "+APIPrefix+"/user", a.getUser)
	mux.HandleFunc("GET "+APIPrefix+"/config", a.getConfig)

	mux.HandleFunc("GET "+APIPrefix+"/tenants", a.listTenants)
	mux.HandleFunc("POST "+APIPrefix+"/tenants", a.createTenant)
	mux.HandleFunc("GET "+APIPrefix+"/tenants/{id}", a.getTenant)
	mux.HandleFunc("PATCH "+APIPrefix+"/tenants/{id}", a.patchTenant)
	mux.HandleFunc("DELETE "+APIPrefix+"/tenants/{id}", a.deleteTenant)
	mux.HandleFunc("GET "+APIPrefix+"/models", a.listModels)
	mux.HandleFunc("POST "+APIPrefix+"/models", a.createModel)
	mux.HandleFunc("GET "+APIPrefix+"/models/{namespace}/{name}", a.getModel)
	mux.HandleFunc("PATCH "+APIPrefix+"/models/{namespace}/{name}", a.patchModel)
	mux.HandleFunc("DELETE "+APIPrefix+"/models/{namespace}/{name}", a.deleteModel)
	mux.HandleFunc("GET "+APIPrefix+"/capabilities", a.getCapabilities)
	mux.HandleFunc("GET "+APIPrefix+"/locations", a.listLocations)
	mux.HandleFunc("GET "+APIPrefix+"/grid/overview", a.getGridOverview)

	// Unknown API paths get a JSON 404 instead of the SPA fallback, and a known
	// path asked with another method a JSON 405.
	mux.HandleFunc(apiCatchAll, func(w http.ResponseWriter, r *http.Request) { a.noRoute(mux, w, r) })
}

// apiCatchAll is the pattern every API request no route takes falls to.
const apiCatchAll = APIPrefix + "/"

// routeMethods are the methods the API's routes use; a GET route also
// answers HEAD.
var routeMethods = []string{http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete}

// noRoute answers a request no route took. The catch-all matches every
// method, so net/http's own 405 never happens: when a route exists for the
// path with other methods, the answer is 405 with those in Allow (RFC 9110
// 15.5.6), otherwise 404, both in the JSON error shape.
func (a *App) noRoute(mux *http.ServeMux, w http.ResponseWriter, r *http.Request) {
	var allow []string
	for _, method := range routeMethods {
		probe := &http.Request{Method: method, URL: r.URL, Host: r.Host, Header: http.Header{}}
		if _, pattern := mux.Handler(probe); pattern != "" && pattern != apiCatchAll {
			allow = append(allow, method)
		}
	}
	if len(allow) == 0 {
		writeError(w, http.StatusNotFound, "the requested resource could not be found")
		return
	}
	w.Header().Set("Allow", strings.Join(allow, ", "))
	writeError(w, http.StatusMethodNotAllowed, fmt.Sprintf("%s is not allowed on %s; use %s", r.Method, r.URL.Path, strings.Join(allow, ", ")))
}
