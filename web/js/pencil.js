// pencil.js: Some scripting for the Pencil.
// It is used whenever a user edits a file with the Pencil.
// Copyright © 2011 Jan Keromnes. All rights reserved.
// The following code is covered by the GPLv2 license.


// Navigation.
//

(function() {

  // We can go back on shortcut
  var goback = true;

  addEventListener('keydown', function(e) {
    if (goback && (e.keyCode === 8 || e.keyCode === 37)) {
      // Can go back and (Backspace or Left).
      //history.go(-1);
      var loc = window.location;
      window.location = loc.protocol + '//' + loc.host +
        loc.pathname.replace(/\/[^\/]+[\/]*$/,'/') + loc.search;
    } else {
      goback = false;
    }
  }, false);

})();



// UI.
//

(function() {

  // Change theme.
  window.selectTheme = function(node) {
    var theme = node.options[node.selectedIndex].innerHTML;
    editor.setOption("theme", theme);
    document.body.className = document.body.className.replace(/cm-s-\w+/, "cm-s-"+theme);
  }

})();
