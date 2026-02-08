from ultralytics import YOLO
import cv2
import time
from datetime import datetime, timedelta
import json

#current_datetime = datetime.now()
#current_time = current_datetime.time()

print("START")

# Load a pre-trained YOLOv8 model
model = YOLO('yolov8n.pt')

# Open the default camera (0)
cap = cv2.VideoCapture(0)

class_names = model.names

file = open("output.txt", "a")

frames_tolerated = 120 # NOTE: edit this with how many frames you want to tolerate toothbrush undetected

counter = frames_tolerated
start_time_lock = False
end_time_lock = True

while cap.isOpened():
    success, frame = cap.read()
    if not success:
        break

    # Run detection on the current frame
    results = model(frame)
    #file.write(str(results) + "\n\n\n")
    
    
    for box in results[0].boxes:
        class_id = int(box.cls[0])  # Get the class ID
        label = class_names[class_id] # Get the string name (e.g., 'person')
        confidence = float(box.conf[0]) # Get the confidence score

        if (label == "toothbrush") and (start_time_lock == False):
            start_time_lock = True
            end_time_lock = False
            start_time = time.perf_counter()
            break
    else:
        counter = counter - 1
        if (counter == 0):
            counter = frames_tolerated
            if (end_time_lock == False):
                start_time_lock = False
                end_time_lock = True
                end_time = time.perf_counter()
                #file.write(f"Toothbrush Detected for {(end_time - start_time):.10f} seconds! {confidence}% sure!\n")
                
                current_datetime = datetime.now()
                future_time = current_datetime + timedelta(seconds=(end_time - start_time))
                hash_value = {"hash_value": str(future_time.time())}
                json_string = json.dumps(hash_value)
                #file.write(json_string + "\n\n\n\n")
    
    # Visualize the results on the frame
    annotated_frame = results[0].plot()

    cv2.imshow("YOLOv8 Detection", annotated_frame)

    # Exit if 'q' is pressed
    if cv2.waitKey(1) & 0xFF == ord('q'):
        break

file.close()
cap.release()
cv2.destroyAllWindows()