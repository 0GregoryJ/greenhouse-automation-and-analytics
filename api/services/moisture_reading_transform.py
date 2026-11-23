import numpy as np

def transform_moisture_readings(readings):
    """Calculate a calibrated soil moisture reading (percentage) by computing what fraction of the last
    10 raw readings were above 990 and multiplying by 100. If >=4/10 -> wet-like, if < 4/10 -> dry-like.
    """
    qty_above_990 = 0
    for reading in readings:
        #10 readings expected but compute the fraction of any length list
        if reading >= 990:
            qty_above_990 += 1

    calibrated_pct = int(100*(np.round((qty_above_990/len(readings)), 2)))

    if calibrated_pct >= 40:
        state = "wet-like"
    else:
        state = "dry-like"

    return (calibrated_pct, state)
