package tools.salvium;

import android.content.Context;
import android.util.AttributeSet;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;

import com.getcapacitor.CapacitorWebView;

public class SalviumWebView extends CapacitorWebView {
    public SalviumWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    @Override
    public InputConnection onCreateInputConnection(EditorInfo outAttrs) {
        InputConnection connection = super.onCreateInputConnection(outAttrs);
        if (outAttrs != null) {
            outAttrs.imeOptions |= EditorInfo.IME_FLAG_NO_EXTRACT_UI;
            outAttrs.imeOptions |= EditorInfo.IME_FLAG_NO_FULLSCREEN;
        }
        return connection;
    }
}
